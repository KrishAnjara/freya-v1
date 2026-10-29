import { NextResponse } from "next/server";
import { isIP } from "node:net";
import { consumeChatRateLimit, isSelfHosted, RateLimitUnavailableError } from "@/lib/rate-limit";

/**
 * Transcribes a voice message with Groq's Whisper, so FREYA can read what was said.
 *
 * The audio is forwarded once and not stored. The key stays on the server, and failures are
 * logged by status only.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ~3 MB of audio as base64: a couple of minutes of browser-recorded Opus. */
const MAX_AUDIO_CHARS = 4_000_000;
const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac"]);

function clientSubject(request: Request): string | null {
  if (isSelfHosted()) return "self-hosted-owner";
  const header = process.env.FREYA_TRUSTED_IP_HEADER?.trim().toLowerCase() || (process.env.NODE_ENV === "production" ? "" : "x-real-ip");
  const candidate = header ? request.headers.get(header)?.trim() : undefined;
  if (candidate && isIP(candidate)) return candidate;
  return process.env.NODE_ENV === "production" ? null : "local-development";
}

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_AUDIO_CHARS + 2000) {
    return NextResponse.json({ error: "That voice message is too long." }, { status: 413 });
  }
  let body: { audio?: unknown; mime?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const mime = typeof body.mime === "string" ? body.mime.split(";")[0].trim().toLowerCase() : "";
  const audio = body.audio;
  if (!AUDIO_TYPES.has(mime) || typeof audio !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(audio)) {
    return NextResponse.json({ error: "That recording could not be read." }, { status: 400 });
  }
  if (audio.length > MAX_AUDIO_CHARS) return NextResponse.json({ error: "That voice message is too long." }, { status: 413 });

  const subject = clientSubject(request);
  if (!subject) return NextResponse.json({ error: "Voice messages are unavailable right now." }, { status: 503 });
  try {
    const limit = await consumeChatRateLimit({ type: "edge", subject });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many messages. Wait a moment and try again." }, { status: 429, headers: { "Retry-After": String(Math.max(1, limit.retryAfterSeconds)) } });
    }
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) return NextResponse.json({ error: "Voice messages are unavailable right now." }, { status: 503 });
    throw error;
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) return NextResponse.json({ error: "Voice messages need GROQ_API_KEY for transcription." }, { status: 503 });

  const extension = mime.split("/")[1].replace("x-", "").replace("mpeg", "mp3");
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(audio, "base64")], { type: mime }), `voice.${extension}`);
  form.append("model", process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3");
  form.append("response_format", "json");
  try {
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn(`FREYA transcription unavailable (${response.status}).`);
      return NextResponse.json({ error: "That voice message could not be transcribed. Try again." }, { status: 502 });
    }
    const text = typeof payload.text === "string" ? payload.text.trim().slice(0, 6000) : "";
    return NextResponse.json({ text });
  } catch {
    console.warn("FREYA transcription unavailable (network).");
    return NextResponse.json({ error: "That voice message could not be transcribed. Try again." }, { status: 502 });
  }
}
