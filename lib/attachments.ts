/**
 * Attachments shared by the browser and the chat route.
 *
 * Images and PDFs travel as base64 and are shown to the vision-capable provider (Gemini).
 * Text and code files are read as text and folded into the message. Anything else is kept
 * for the user to download again, and the model is told only its name, type and size.
 *
 * This module is client-safe: no server imports.
 */

export type AttachmentKind = "image" | "pdf" | "audio" | "text" | "file";

/** What a message stores about an attachment. The bytes live in IndexedDB, not localStorage. */
export type AttachmentMeta = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  /** A small JPEG data URL so history renders without loading the full file. */
  thumb?: string;
};

/** What the chat route receives for the current turn. */
export type WireAttachment = { name: string; mime: string; kind: AttachmentKind; data?: string; text?: string };

export const MAX_ATTACHMENTS = 4;
/** Largest file accepted from the picker, before any downscaling. */
export const MAX_FILE_BYTES = 12 * 1024 * 1024;
/** Base64 limits, checked again on the server. */
export const MAX_IMAGE_DATA_CHARS = 1_600_000;
export const MAX_PDF_DATA_CHARS = 4_000_000;
/** A minute of 16 kHz mono WAV is ~2.6 MB as base64. */
export const MAX_AUDIO_DATA_CHARS = 2_800_000;
/** Audio formats Gemini accepts as input. */
export const AUDIO_MIMES = new Set(["audio/wav", "audio/x-wav", "audio/mp3", "audio/mpeg", "audio/aac", "audio/ogg", "audio/flac", "audio/aiff"]);
/** All text attachments in one turn together. ~4,000 tokens, inside Groq's per-minute budget. */
export const MAX_TEXT_ATTACHMENT_CHARS = 16_000;
export const MAX_WIRE_DATA_CHARS = 5_200_000;

export const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_EXTENSIONS = new Set(("txt md markdown csv tsv json jsonl js mjs cjs ts tsx jsx py rb go rs java kt c h cpp hpp cs " +
  "php html htm css scss xml yaml yml toml ini cfg conf log sql sh bash ps1 bat swift lua r m dart vue svelte srt vtt tex").split(" "));

export function extensionOf(name: string) {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

export function classifyAttachment(mime: string, name: string): AttachmentKind {
  const type = mime.toLowerCase();
  if (IMAGE_MIMES.has(type)) return "image";
  if (type === "application/pdf" || extensionOf(name) === "pdf") return "pdf";
  if (AUDIO_MIMES.has(type)) return "audio";
  if (type.startsWith("text/") || /json|xml|javascript|typescript|yaml|x-sh|sql/.test(type) || TEXT_EXTENSIONS.has(extensionOf(name))) return "text";
  return "file";
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** The line the model reads in place of, or alongside, an attachment. */
export function attachmentNote(attachment: { name: string; kind: AttachmentKind; mime: string; size?: number }) {
  const label = attachment.kind === "image" ? "image" : attachment.kind === "pdf" ? "PDF" : attachment.kind === "audio" ? "audio" : "file";
  const size = attachment.size ? `, ${formatBytes(attachment.size)}` : "";
  return `[Attached ${label}: ${attachment.name.slice(0, 120)} (${attachment.mime || "unknown type"}${size})]`;
}

export class AttachmentError extends Error {}

/** Validates the attachments of one wire message. Throws AttachmentError on anything off. */
export function parseWireAttachments(input: unknown): WireAttachment[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new AttachmentError("Attachments must be a list.");
  if (input.length > MAX_ATTACHMENTS) throw new AttachmentError(`Send at most ${MAX_ATTACHMENTS} attachments at a time.`);
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new AttachmentError("An attachment is invalid.");
    const candidate = item as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name.replace(/[\r\n\t]/g, " ").trim().slice(0, 160) : "";
    const mime = typeof candidate.mime === "string" ? candidate.mime.trim().toLowerCase().slice(0, 100) : "";
    if (!name) throw new AttachmentError("An attachment has no name.");
    // The kind is re-derived here; the browser's label is not trusted.
    const kind = classifyAttachment(mime, name);
    if (kind === "image" || kind === "pdf" || kind === "audio") {
      const data = candidate.data;
      if (typeof data !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new AttachmentError(`${name} could not be read.`);
      const limit = kind === "image" ? MAX_IMAGE_DATA_CHARS : kind === "pdf" ? MAX_PDF_DATA_CHARS : MAX_AUDIO_DATA_CHARS;
      if (data.length > limit) throw new AttachmentError(`${name} is too large.`);
      return { name, mime: kind === "pdf" ? "application/pdf" : mime === "audio/x-wav" ? "audio/wav" : mime, kind, data };
    }
    if (kind === "text") {
      const text = typeof candidate.text === "string" ? candidate.text.slice(0, MAX_TEXT_ATTACHMENT_CHARS) : "";
      return { name, mime: mime || "text/plain", kind, text };
    }
    return { name, mime, kind };
  });
}
