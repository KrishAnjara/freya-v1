// FREYA's Puter bridge: her voice through Puter.js, spoken as Ollama's chat API, so the Colab
// gateway (training/serve_puter.py) and the app use it exactly like her own Ollama server.
//
//   POST /api/chat   "freya"           Puter: Qwen3.8 27B Uncensored, then the fallback models
//                    "freya-fallback"  the fallback models only
//                    "freya-vision"    a Puter model that can see (what they send), for her notes
//   POST /api/show   what each of those can do
//   GET  /api/tags   those names, plus whatever the local Ollama has
//   GET  /bridge     state: signed in to Puter, which models answer (no secrets)
//
// The models and switches come from serve_puter.py through the environment. Each one is tried in
// turn until one answers (a Puter model that fails, or answers with nothing but "error", gets one
// more go first: the free models drop the odd request); once she has started answering, a failure
// ends the reply instead of splicing in another model's. When none answers, it says 503 (up, but
// failing), never 502, which the app reads as the server being gone. Logs say which model answered
// or failed, never what was said.
// Needs Node 24+ and @heyputer/puter.js (serve_puter.py installs both) and PUTER_AUTH_TOKEN.
import http from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { init } = require("@heyputer/puter.js/src/init.cjs");

const env = process.env;
const PORT = Number(env.FREYA_BRIDGE_PORT || 11500);
const OLLAMA = (env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const list = (value, fallback) => { try { const parsed = JSON.parse(value || ""); return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string" && item) : fallback; } catch { return fallback; } };
const VOICES = list(env.FREYA_PUTER_MODELS, ["infron:qwen/qwen3.8-27b:free"]);
const EYES = list(env.FREYA_PUTER_VISION, []);
/** This server's own Ollama, as the last voice and the last eyes: "" switches it off. */
const LOCAL_VOICE = env.FREYA_LOCAL_VOICE || "";
const LOCAL_EYES = env.FREYA_LOCAL_VISION || "";
/** No first word in this long: that model is skipped for this reply. */
// A model that hasn't said a word in this long is stuck: the next one takes over. Her usual first word
// comes in 1-3 s, so this is generous; 90 s made a stuck model hold a reply for a minute and a half.
const FIRST_WORD_MS = Number(env.FREYA_FIRST_WORD_MS || 30_000);
/** All the tries for one reply fit in this, inside the minute the app waits for a first word. */
const CHAIN_MS = Number(env.FREYA_CHAIN_MS || 55_000);
/** Before a second go: a moment, or longer when Puter said it was rate-limited or busy. */
const RETRY_PAUSE_MS = 1200;
const BUSY_PAUSE_MS = 4000;
const BUSY = /rate.?limit|too many|429|busy|overloaded|capacity/i;
/** A whole reply that's only this is Puter failing, not her talking. */
const JUNK = /^\W*(error|null|undefined|\[object object\])\W*$/i;

const log = (area, message) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${area.padEnd(8)} ${message}`);
const puter = init(env.PUTER_AUTH_TOKEN || "");
const state = { signedIn: false, user: "", voices: VOICES, eyes: EYES, lastAnswer: "", lastFailure: "" };

/** Models Puter knows, so a configured name that is spelled differently there still finds its model. */
async function resolveModels() {
  try {
    const user = await puter.auth.getUser();
    state.signedIn = true;
    state.user = user?.username || "";
    log("puter", `signed in${state.user ? ` as ${state.user}` : ""}`);
  } catch (error) {
    log("puter", `not signed in: ${reason(error)} (check PUTER_AUTH_TOKEN)`);
  }
  let known = [];
  try {
    const models = await puter.ai.listModels();
    known = (Array.isArray(models) ? models : []).map((model) => typeof model === "string" ? model : model?.id).filter(Boolean);
  } catch { /* listing isn't essential: the names are used as given */ }
  if (!known.length) return;
  const find = (name) => known.includes(name) ? name : known.find((id) => id.endsWith(name.replace(/^[a-z-]+:/, ""))) || name;
  state.voices = VOICES.map(find);
  state.eyes = EYES.map(find);
  for (const name of [...state.voices, ...state.eyes]) if (!known.includes(name)) log("puter", `${name} isn't in Puter's model list; trying it anyway`);
}

const reason = (error) => String(error?.message || error?.error?.message || error || "unknown").replace(/\s+/g, " ").slice(0, 200);

const MIME = [["/9j/", "image/jpeg"], ["iVBOR", "image/png"], ["UklGR", "image/webp"], ["R0lGOD", "image/gif"]];
const mimeOf = (data) => MIME.find(([start]) => data.startsWith(start))?.[1] || "image/png";

/** Ollama's messages (text, and pictures as base64 in `images`) in Puter's (OpenAI-style) form. */
function puterMessages(messages, files = "inline") {
  return Promise.all(messages.map(async (message) => {
    const role = ["system", "user", "assistant"].includes(message.role) ? message.role : "user";
    const text = typeof message.content === "string" ? message.content : "";
    const images = Array.isArray(message.images) ? message.images.filter((item) => typeof item === "string") : [];
    if (!images.length) return { role, content: text };
    const parts = [{ type: "text", text }];
    for (const [index, data] of images.entries()) {
      const mime = mimeOf(data);
      if (files === "inline") parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${data}` } });
      else {
        // Some Puter models take files only from Puter's own storage.
        const name = `freya-${randomUUID().slice(0, 8)}-${index}.${mime.split("/")[1]}`;
        const item = await puter.fs.write(`freya-uploads/${name}`, new File([Buffer.from(data, "base64")], name, { type: mime }), { createMissingParents: true });
        parts.push({ type: "file", puter_path: item?.path || `freya-uploads/${name}` });
      }
    }
    return { role, content: parts };
  }));
}

/** One Puter model's reply, as text pieces. */
async function* fromPuter(model, body, signal, files) {
  const options = { model, stream: true, signal };
  const predict = Number(body.options?.num_predict);
  if (Number.isFinite(predict) && predict > 0) options.max_tokens = predict;
  const temperature = Number(body.options?.temperature);
  if (Number.isFinite(temperature)) options.temperature = temperature;
  const response = await puter.ai.chat(await puterMessages(body.messages || [], files), false, options);
  if (response && typeof response[Symbol.asyncIterator] === "function") {
    for await (const part of response) {
      if (part?.type === "error") throw new Error(part.message || "Puter reported an error");
      if (part?.type === "reasoning") { if (body.think) yield { thinking: part.reasoning ?? part.text ?? "" }; continue; }
      if (typeof part?.text === "string" && part.text) yield { content: part.text };
    }
    return;
  }
  // A model that answered all at once.
  const content = response?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => block?.text || "").join("") : "";
  if (text) yield { content: text };
}

/** This server's own Ollama (on the CPU, so it never fights a picture for the GPU). */
async function* fromOllama(model, body, signal) {
  const response = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST", signal, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, model, stream: true, keep_alive: "5m", options: { ...(body.options || {}), num_gpu: 0 } }),
  });
  if (!response.ok || !response.body) throw new Error(`local Ollama answered ${response.status}`);
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      if (data.message?.thinking && body.think) yield { thinking: data.message.thinking };
      if (data.message?.content) yield { content: data.message.content };
    }
  }
}

/** Who answers a name, in order. */
function chainFor(name, body) {
  const seeing = (body.messages || []).some((message) => Array.isArray(message.images) && message.images.length);
  const options = [];
  if (name === "freya-vision" || seeing) {
    for (const model of state.eyes) {
      options.push({ label: model, run: (signal) => fromPuter(model, body, signal, "inline") });
      options.push({ label: `${model} (file)`, run: (signal) => fromPuter(model, body, signal, "puter") });
    }
    if (LOCAL_EYES) options.push({ label: `local ${LOCAL_EYES}`, run: (signal) => fromOllama(LOCAL_EYES, body, signal) });
    return options;
  }
  const voices = name === "freya-fallback" ? state.voices.slice(1) : state.voices;
  for (const model of voices) options.push({ label: model, retry: true, run: (signal) => fromPuter(model, body, signal, "inline") });
  if (LOCAL_VOICE) options.push({ label: `local ${LOCAL_VOICE}`, run: (signal) => fromOllama(LOCAL_VOICE, body, signal) });
  return options;
}

const pause = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * One go at one model. The opening is held back until it's clearly more than a failure word, so a
 * reply of just "error" (or nothing) is a failure that can be tried again, not something she says.
 * `progress.emitted` counts what has gone out: after that, it can't be tried again.
 */
async function* attempt(option, windowMs, clientSignal, progress) {
  const controller = new AbortController();
  let timedOut = false;
  const stop = () => controller.abort();
  clientSignal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, windowMs);
  let held = [];
  let opening = "";
  try {
    for await (const piece of option.run(controller.signal)) {
      clearTimeout(timer);
      if (held) {
        held.push(piece);
        opening += piece.content || "";
        if (opening.replace(/\s/g, "").length < 12) continue;
        const release = held;
        held = null;
        for (const item of release) { progress.emitted += (item.content || "").length; yield item; }
        continue;
      }
      progress.emitted += (piece.content || "").length;
      yield piece;
    }
    if (timedOut) throw new Error(`no answer in ${Math.round(windowMs / 1000)} s`);
    if (held) {
      if (!opening.trim()) throw new Error("an empty reply");
      if (JUNK.test(opening)) throw new Error(`a reply of just "${opening.trim().slice(0, 24)}"`);
      for (const item of held) { progress.emitted += (item.content || "").length; yield item; }
    }
  } catch (error) {
    if (timedOut && !clientSignal.aborted) throw new Error(`no answer in ${Math.round(windowMs / 1000)} s`);
    throw error;
  } finally {
    clearTimeout(timer);
    clientSignal.removeEventListener("abort", stop);
  }
}

/** Walks the chain: the first model that answers carries the whole reply. */
async function* answer(name, body, clientSignal) {
  const started = Date.now();
  let lastError = new Error("no model is set up to answer");
  for (const option of chainFor(name, body)) {
    for (let go = 0; go < (option.retry ? 2 : 1); go += 1) {
      if (go) {
        await pause(BUSY.test(reason(lastError)) ? BUSY_PAUSE_MS : RETRY_PAUSE_MS, clientSignal);
        if (clientSignal.aborted) throw lastError;
      }
      const left = CHAIN_MS - (Date.now() - started);
      if (left < 5000) throw lastError;
      const progress = { emitted: 0 };
      const begun = Date.now();
      try {
        yield* attempt(option, Math.min(FIRST_WORD_MS, left), clientSignal, progress);
        state.lastAnswer = option.label;
        log("chat", `${name}: ${option.label}${go ? " (second go)" : ""} answered in ${((Date.now() - begun) / 1000).toFixed(1)} s (${progress.emitted} chars)`);
        return;
      } catch (error) {
        if (clientSignal.aborted) throw error;
        if (progress.emitted) { log("chat", `${name}: ${option.label} broke off mid-reply: ${reason(error)}`); throw error; }
        lastError = error;
        state.lastFailure = `${option.label}: ${reason(error)}`;
        log("chat", `${name}: ${option.label} failed (${reason(error)}); ${option.retry && !go ? "one more go" : "trying the next"}`);
      }
    }
  }
  throw lastError;
}

const NAMES = ["freya", "freya-fallback", "freya-vision"];

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const json = (response, status, payload) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
};

async function chat(request, response, body) {
  const name = NAMES.includes(body.model) ? body.model : "freya";
  const client = new AbortController();
  response.on("close", () => { if (!response.writableFinished) client.abort(); });
  const line = (message, done = false, extra = {}) => `${JSON.stringify({ model: name, created_at: new Date().toISOString(), message: { role: "assistant", content: "", ...message }, done, ...extra })}\n`;
  const started = Date.now();
  if (body.stream === false) {
    let content = "";
    let thinking = "";
    try {
      for await (const piece of answer(name, body, client.signal)) { content += piece.content || ""; thinking += piece.thinking || ""; }
      return json(response, 200, JSON.parse(line({ content, ...(thinking ? { thinking } : {}) }, true, { done_reason: "stop", total_duration: (Date.now() - started) * 1e6 })));
    } catch (error) {
      return json(response, 503, { error: `every voice on this server failed: ${reason(error)}` });
    }
  }
  const pieces = answer(name, body, client.signal);
  let first;
  try {
    first = await pieces.next();
  } catch (error) {
    // 503: the server is up and her model failed. (502 tells the app the server is gone.)
    return json(response, 503, { error: `every voice on this server failed: ${reason(error)}` });
  }
  response.writeHead(200, { "Content-Type": "application/x-ndjson" });
  try {
    if (!first.done) response.write(line(first.value));
    for await (const piece of pieces) response.write(line(piece));
    response.end(line({}, true, { done_reason: "stop", total_duration: (Date.now() - started) * 1e6 }));
  } catch (error) {
    if (!response.writableEnded) response.end(`${JSON.stringify({ error: `the reply broke off: ${reason(error)}` })}\n`);
  }
}

async function localTags() {
  try {
    const response = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return response.ok ? ((await response.json()).models || []) : [];
  } catch {
    return [];
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://bridge").pathname;
    if (request.method === "GET" && path === "/bridge") return json(response, 200, { ...state, local: { voice: LOCAL_VOICE, vision: LOCAL_EYES } });
    if (request.method === "GET" && path === "/api/version") return json(response, 200, { version: "freya-puter-bridge" });
    if (request.method === "GET" && path === "/api/tags") {
      const own = NAMES.map((name) => ({ name, model: name, details: { family: "puter" } }));
      return json(response, 200, { models: [...own, ...(await localTags())] });
    }
    const raw = request.method === "POST" ? await readBody(request) : "";
    const body = raw ? JSON.parse(raw) : {};
    if (path === "/api/show") {
      if (!NAMES.includes(body.model)) return json(response, 404, { error: `model '${body.model}' not found` });
      return json(response, 200, { capabilities: body.model === "freya-vision" ? ["completion", "vision"] : ["completion"], details: { family: "puter" }, model_info: {} });
    }
    if (path === "/api/chat" && request.method === "POST") return chat(request, response, body);
    return json(response, 404, { error: "not here" });
  } catch (error) {
    if (!response.headersSent) json(response, 400, { error: reason(error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log("bridge", `listening on 127.0.0.1:${PORT} · voices ${VOICES.join(" > ")}${LOCAL_VOICE ? ` > local ${LOCAL_VOICE}` : ""} · eyes ${EYES.join(" > ")}${LOCAL_EYES ? ` > local ${LOCAL_EYES}` : ""}`);
  void resolveModels();
});
