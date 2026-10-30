/**
 * One structured (JSON) completion for background jobs: memory reflection and visualisation.
 *
 * Groq in JSON mode first, then Gemini with a JSON response type. Sampling is fixed and low:
 * these are extraction and layout tasks, not FREYA's voice, and no client can change them.
 * Failures are logged by status only, never with provider text.
 */
export type StructuredResult = { data: unknown; provider: "groq" | "gemini" };

type Options = { groqModel: string; maxTokens: number; temperature?: number; signal?: AbortSignal; timeoutMs?: number; reasoningEffort?: "low" | "medium" | "high" };

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return JSON.");
  return JSON.parse(trimmed.slice(start, end + 1));
}

async function groqJson(system: string, user: string, options: Options): Promise<unknown> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set.");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: options.groqModel,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: options.temperature ?? 0.2,
      max_completion_tokens: options.maxTokens,
      response_format: { type: "json_object" },
      ...(/gpt-oss/i.test(options.groqModel) ? { reasoning_effort: options.reasoningEffort ?? "low" } : {}),
    }),
    signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])]),
  });
  if (!response.ok) throw new Error(`Groq ${response.status}`);
  const payload = await response.json();
  return parseJson(String(payload?.choices?.[0]?.message?.content ?? ""));
}

async function geminiJson(system: string, user: string, options: Options): Promise<unknown> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set.");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: options.temperature ?? 0.2, maxOutputTokens: Math.max(options.maxTokens, 4096), responseMimeType: "application/json" },
    }),
    signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])]),
  });
  if (!response.ok) throw new Error(`Gemini ${response.status}`);
  const payload = await response.json();
  const text = (payload?.candidates?.[0]?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? "").join("");
  return parseJson(text);
}

/**
 * Each Groq model has its own per-minute token bucket, so a rate-limited first model is
 * followed by a second one (FREYA_STRUCTURED_FALLBACK_MODEL) before Gemini.
 */
export async function generateJson(system: string, user: string, options: Options): Promise<StructuredResult> {
  const fallback = process.env.FREYA_STRUCTURED_FALLBACK_MODEL?.trim() || "openai/gpt-oss-20b";
  const models = [...new Set([options.groqModel, fallback])];
  for (const model of models) {
    try {
      return { data: await groqJson(system, user, { ...options, groqModel: model }), provider: "groq" };
    } catch (groqError) {
      if (options.signal?.aborted) throw groqError;
      console.warn(`FREYA structured job: Groq ${model} unavailable (${groqError instanceof Error ? groqError.message.slice(0, 40) : "error"}).`);
    }
  }
  return { data: await geminiJson(system, user, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 30_000, 45_000) }), provider: "gemini" };
}
