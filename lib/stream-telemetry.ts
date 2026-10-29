/**
 * Real, observable signals from the chat stream, recorded for the activity canvas.
 *
 * The model providers behind FREYA (Groq, Gemini, Ollama) expose no activations, attention
 * weights, logits or hidden reasoning through the API this app uses. What the browser can
 * genuinely observe is:
 *
 *   MEASURED  when the request started, when search metadata and each streamed chunk arrived
 *             (client clock, so network jitter is included), each chunk's text, which
 *             provider answered, and how the stream ended.
 *   DERIVED   arithmetic on the measured data: time to first chunk, gaps between chunks,
 *             characters per second, and lexical links — a later chunk reusing a word from an
 *             earlier chunk or from the prompt. Lexical links are string matching, NOT attention.
 *
 * Anything else the canvas draws (the lattice, its layout) is illustrative scaffolding, and
 * the canvas labels it as such. Nothing here is a model internal.
 *
 * Framework-free, like mouth-drive: the render loop reads `state` every frame, and React
 * subscribes for the low-frequency HUD.
 */

export type StreamPhase = "idle" | "waiting" | "streaming" | "done" | "error" | "aborted";

export type Fragment = {
  /** The streamed chunk exactly as received. */
  text: string;
  /** Arrival time, ms since the request started (client clock). */
  at: number;
  /** Gap since the previous chunk, ms. */
  gap: number;
  /** Content words, used for lexical links. */
  words: string[];
};

/** A lexical link: fragment `to` reuses a word last seen in fragment `from` (-1 = the prompt). */
export type LexicalLink = { from: number; to: number; word: string };

export type StreamTelemetry = {
  phase: StreamPhase;
  /** performance.now() at request start. */
  startedAt: number;
  /** ms from start to the search metadata event, or null. */
  metaAt: number | null;
  /** ms from start to the first chunk, or null. */
  firstChunkAt: number | null;
  /** ms from start to completion, or null. */
  endedAt: number | null;
  provider: string;
  searchStatus: string;
  sourceCount: number;
  totalChars: number;
  truncated: boolean;
  fragments: Fragment[];
  links: LexicalLink[];
  promptWords: string[];
  /** Bumps on every change; the render loop compares it to spot new events. */
  revision: number;
};

/** Hard caps so a very long reply cannot grow GPU buffers or this store without bound. */
export const MAX_FRAGMENTS = 320;
export const MAX_LINKS = 640;

const STOPWORDS = new Set(("about after again also always another because been before being between both could does " +
  "doing during each from have having here into just like made make many more most much must only other over same should " +
  "since some such than that their them then there these they thing this those through under very what when where which " +
  "while will with would your yours you're it's that's there's i'm don't can't won't isn't said says even well " +
  "really still want know think going yeah okay sure").split(" "));

/** Content words: lower-cased, letters/digits, length >= 4, no stopwords. */
export function contentWords(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  return words.filter((word) => word.length >= 4 && !STOPWORDS.has(word));
}

function blank(): StreamTelemetry {
  return {
    phase: "idle", startedAt: 0, metaAt: null, firstChunkAt: null, endedAt: null,
    provider: "", searchStatus: "", sourceCount: 0, totalChars: 0, truncated: false,
    fragments: [], links: [], promptWords: [], revision: 0,
  };
}

export const state: StreamTelemetry = blank();

/** Most recent fragment index for each content word; source of lexical links. */
let lastSeen = new Map<string, number>();
/** A word not yet linked to its token fragment; chunk boundaries often split words. */
let pendingTail = "";

const listeners = new Set<() => void>();
let notifyQueued = false;
function emit() {
  state.revision += 1;
  // Chunks can arrive hundreds per second; coalesce React notifications to one per frame.
  if (notifyQueued) return;
  notifyQueued = true;
  const flush = () => { notifyQueued = false; for (const listener of listeners) listener(); };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else queueMicrotask(flush);
}

export function subscribeTelemetry(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function telemetryRevision() {
  return state.revision;
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** A request was sent. `prompt` is the user's message, used only for lexical links. */
export function beginStream(prompt: string) {
  const revision = state.revision;
  Object.assign(state, blank(), { revision, phase: "waiting" as StreamPhase, startedAt: now() });
  state.promptWords = [...new Set(contentWords(prompt))].slice(0, 64);
  lastSeen = new Map(state.promptWords.map((word) => [word, -1]));
  pendingTail = "";
  emit();
}

export function recordMeta(sourceCount: number, searchStatus: string) {
  if (state.phase === "idle") return;
  state.metaAt = now() - state.startedAt;
  state.sourceCount = sourceCount;
  state.searchStatus = searchStatus;
  emit();
}

export function recordProvider(provider: string) {
  if (state.phase === "idle") return;
  state.provider = provider;
  emit();
}

/** One streamed chunk, exactly as the server forwarded it. */
export function recordChunk(text: string) {
  if (state.phase !== "waiting" && state.phase !== "streaming") return;
  const at = now() - state.startedAt;
  if (state.firstChunkAt === null) state.firstChunkAt = at;
  state.phase = "streaming";
  state.totalChars += text.length;

  // Words split across chunk boundaries ("cogni" + "tion") are completed before matching.
  const joined = pendingTail + text;
  const tailMatch = joined.match(/[\p{L}\p{N}'’-]+$/u);
  pendingTail = tailMatch ? tailMatch[0] : "";
  const complete = tailMatch ? joined.slice(0, joined.length - pendingTail.length) : joined;

  const previous = state.fragments[state.fragments.length - 1];
  const fragment: Fragment = { text, at, gap: previous ? at - previous.at : at, words: contentWords(complete) };
  if (state.fragments.length >= MAX_FRAGMENTS) {
    // Past the cap the timing stats keep counting, but no new geometry is created.
    emit();
    return;
  }
  const index = state.fragments.push(fragment) - 1;
  for (const word of fragment.words) {
    const from = lastSeen.get(word);
    if (from !== undefined && from !== index && state.links.length < MAX_LINKS) {
      state.links.push({ from, to: index, word });
    }
    lastSeen.set(word, index);
  }
  emit();
}

export function finishStream(truncated = false) {
  if (state.phase !== "waiting" && state.phase !== "streaming") return;
  state.phase = "done";
  state.truncated = truncated;
  state.endedAt = now() - state.startedAt;
  emit();
}

export function failStream(aborted = false) {
  if (state.phase !== "waiting" && state.phase !== "streaming") return;
  state.phase = aborted ? "aborted" : "error";
  state.endedAt = now() - state.startedAt;
  emit();
}

/** Derived figures for the HUD. All arithmetic on measured values; nothing estimated. */
export function streamStats(at = now()) {
  const elapsed = state.endedAt ?? (state.phase === "idle" ? 0 : at - state.startedAt);
  const gaps = state.fragments.slice(1).map((fragment) => fragment.gap).sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const streamingMs = state.firstChunkAt === null ? 0 : elapsed - state.firstChunkAt;
  return {
    elapsedMs: Math.max(0, elapsed),
    firstChunkMs: state.firstChunkAt,
    chunks: state.fragments.length,
    medianGapMs: median,
    charsPerSecond: streamingMs > 250 ? (state.totalChars / streamingMs) * 1000 : null,
    links: state.links.length,
    promptLinks: state.links.filter((link) => link.from === -1).length,
  };
}

/** For deterministic tests. */
export function resetTelemetryForTests() {
  Object.assign(state, blank());
  lastSeen = new Map();
  pendingTail = "";
}
