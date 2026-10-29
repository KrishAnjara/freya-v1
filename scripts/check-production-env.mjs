import nextEnv from "@next/env";

// Load .env files exactly the way `next start` will. This script runs under plain node, which
// loads none of them, so without this every key in .env was reported missing even when set.
nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });

const selfHosted = process.env.FREYA_SELF_HOSTED?.trim().toLowerCase() === "true";

const failures = [];
const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value || /^(replace_me|your_|YOUR_)/i.test(value)) failures.push(`${name} is missing or still a placeholder`);
  return value;
};

const provider = (process.env.AI_PROVIDER || "groq").trim().toLowerCase();
if (!new Set(["ollama", "groq", "gemini", "hybrid"]).has(provider)) {
  failures.push("AI_PROVIDER must be ollama, groq, gemini, or hybrid");
} else if (provider === "hybrid") {
  // The local model speaks; a cloud key is needed for the research brief and the fallback.
  if (!process.env.GROQ_API_KEY?.trim() && !process.env.GEMINI_API_KEY?.trim()) {
    failures.push("AI_PROVIDER=hybrid needs GROQ_API_KEY or GEMINI_API_KEY for its research brief and fallback");
  }
} else if (provider === "groq") {
  required("GROQ_API_KEY");
} else if (provider === "gemini") {
  required("GEMINI_API_KEY");
}

if (process.env.AI_FALLBACK_ENABLED !== "false") {
  let fallback = (process.env.AI_FALLBACK_PROVIDER || "groq").trim().toLowerCase();
  if (provider === "hybrid") {
    // Hybrid always falls back to a cloud model; Ollama-to-Ollama would achieve nothing.
    if (fallback !== "groq" && fallback !== "gemini") fallback = "groq";
  } else if (!new Set(["ollama", "groq", "gemini"]).has(fallback) || fallback === provider) {
    fallback = provider === "groq" ? "gemini" : "groq";
  }
  if (!new Set(["ollama", "groq", "gemini"]).has(fallback)) {
    failures.push("AI_FALLBACK_PROVIDER must be a supported provider different from AI_PROVIDER");
  } else if (fallback === "groq") {
    required("GROQ_API_KEY");
  } else if (fallback === "gemini") {
    required("GEMINI_API_KEY");
  }
}

if (selfHosted) {
  // One owner on their own machine: there is no edge proxy to write a client-IP header, and a
  // single process has nothing to share rate limits with. Both checks are hosting concerns.
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
  if (redisUrl && !/^https:\/\//i.test(redisUrl)) failures.push("UPSTASH_REDIS_REST_URL must use HTTPS");
} else {
  const redisUrl = required("UPSTASH_REDIS_REST_URL");
  if (redisUrl && !/^https:\/\//i.test(redisUrl)) failures.push("UPSTASH_REDIS_REST_URL must use HTTPS");
  required("UPSTASH_REDIS_REST_TOKEN");

  const trustedHeader = required("FREYA_TRUSTED_IP_HEADER");
  if (trustedHeader && !["x-vercel-forwarded-for", "cf-connecting-ip", "x-real-ip"].includes(trustedHeader.toLowerCase())) {
    failures.push("FREYA_TRUSTED_IP_HEADER must be a supported header written by the trusted hosting edge");
  }
}

const serviceUrl = process.env.FREYA_SERVICE_URL?.trim();
if (serviceUrl) {
  try {
    const parsed = new URL(serviceUrl);
    const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
      failures.push("FREYA_SERVICE_URL must use HTTPS outside localhost");
    }
  } catch {
    failures.push("FREYA_SERVICE_URL must be a valid URL");
  }
  const token = required("FREYA_SERVICE_TOKEN");
  if (token && token.length < 32) failures.push("FREYA_SERVICE_TOKEN must be at least 32 characters");
}

if (process.env.WEB_SEARCH_ENABLED?.toLowerCase() === "true" && !process.env.GEMINI_API_KEY?.trim() && !process.env.TAVILY_API_KEY?.trim()) {
  failures.push("WEB_SEARCH_ENABLED requires GEMINI_API_KEY or TAVILY_API_KEY");
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
if (Boolean(supabaseUrl) !== Boolean(supabaseKey)) {
  failures.push("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be configured together");
}
if (supabaseUrl) {
  try {
    if (new URL(supabaseUrl).protocol !== "https:") failures.push("NEXT_PUBLIC_SUPABASE_URL must use HTTPS");
  } catch {
    failures.push("NEXT_PUBLIC_SUPABASE_URL must be a valid URL");
  }
}

if (failures.length) {
  console.error("FREYA production configuration check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("Set these values in the hosting secret manager. Values are never printed.");
  process.exitCode = 1;
} else {
  console.log("FREYA production configuration check passed.");
  if (selfHosted) {
    console.log("Self-hosted mode: single owner budget, no proxy identity. Run `npm run start:local`");
    console.log("to bind to this machine only; do not expose a self-hosted instance to the internet.");
  }
}
