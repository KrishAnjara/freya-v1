/**
 * How long each voice really takes to answer, measured in this browser: the time to her first words
 * and to the end of the reply, and how long replies run, as running averages per voice (the label a
 * reply carries: server, laptop, groq, gemini, grok...).
 *
 * The chat uses it to pace her like a person around the model's real speed. A slow voice no longer
 * means a minute of "typing…" for a one-word answer: she reads, stays quiet (the message shows as
 * seen), and starts typing when a reply would plausibly be on its way, or the moment it arrives.
 * Pure apart from the storage helpers, so it is tested directly.
 */

export type Timing = { firstMs: number; totalMs: number; chars: number; samples: number; at: number };
export type Timings = Record<string, Timing>;

/** New measurements count for this much: recent speed matters most (a server warms up, a tunnel changes). */
const WEIGHT = 0.3;
/** One wild measurement (a cold start, a dropped tunnel) can't drag the average past these. */
const MAX_MS = 10 * 60_000;

export function recordTiming(timings: Timings, provider: string, sample: { firstMs: number; totalMs: number; chars: number }, now = Date.now()): Timings {
  const name = provider.trim().toLowerCase();
  if (!name || !Number.isFinite(sample.firstMs) || !Number.isFinite(sample.totalMs) || sample.firstMs < 0 || sample.totalMs < sample.firstMs) return timings;
  const clean = { firstMs: Math.min(MAX_MS, sample.firstMs), totalMs: Math.min(MAX_MS, sample.totalMs), chars: Math.max(0, Math.min(8000, sample.chars)) };
  const known = timings[name];
  const blend = (old: number, value: number) => old + (value - old) * WEIGHT;
  const next: Timing = known
    ? { firstMs: blend(known.firstMs, clean.firstMs), totalMs: blend(known.totalMs, clean.totalMs), chars: blend(known.chars, clean.chars), samples: known.samples + 1, at: now }
    : { ...clean, samples: 1, at: now };
  return { ...timings, [name]: next };
}

/** What to expect from this voice, or (not known yet) from whichever answered most recently. */
export function expectedTiming(timings: Timings, provider?: string): Timing | null {
  const named = provider ? timings[provider.trim().toLowerCase()] : undefined;
  if (named) return named;
  const recent = Object.values(timings).sort((a, b) => b.at - a.at)[0];
  return recent ?? null;
}

/** About how long she'd take to type a reply of this many characters on a phone. */
export function typingLeadMs(chars: number) {
  return Math.max(2500, Math.min(9000, chars * 40));
}

/**
 * When "typing…" should appear (a performance.now() time). She starts once she's read their message,
 * unless the voice is slow: then she pauses after reading and starts a typing-length before the
 * reply is due. A pause under a second and a half isn't worth showing, so then she just types.
 */
export function typingStartsAt(readEnd: number, sentAt: number, expected: Timing | null) {
  if (!expected) return readEnd;
  const due = sentAt + expected.firstMs;
  const start = due - typingLeadMs(expected.chars || 120);
  return start - readEnd < 1500 ? readEnd : start;
}

/** "about 12 s to start, 20 s in all", for the status panel. */
export function describeTiming(timing: Timing) {
  const seconds = (ms: number) => ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
  return `${seconds(timing.firstMs)} to start, ${seconds(timing.totalMs)} in all (${timing.samples} ${timing.samples === 1 ? "reply" : "replies"})`;
}

const KEY = "freya.v1.timings";

export function normalizeTimings(input: unknown): Timings {
  if (!input || typeof input !== "object") return {};
  const out: Timings = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>).slice(0, 20)) {
    const timing = value as Partial<Timing> | null;
    if (!timing || !/^[a-z0-9:._-]{1,40}$/.test(name)) continue;
    const numbers = [timing.firstMs, timing.totalMs, timing.chars, timing.samples, timing.at];
    if (!numbers.every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0)) continue;
    out[name] = { firstMs: Math.min(MAX_MS, timing.firstMs!), totalMs: Math.min(MAX_MS, timing.totalMs!), chars: timing.chars!, samples: timing.samples!, at: timing.at! };
  }
  return out;
}

export function loadTimings(): Timings {
  try { return normalizeTimings(JSON.parse(localStorage.getItem(KEY) || "null")); } catch { return {}; }
}

export function saveTimings(timings: Timings) {
  try { localStorage.setItem(KEY, JSON.stringify(timings)); } catch { /* measured again next time */ }
}
