/**
 * Attachments shared by the browser and the chat route.
 *
 * Files are read on the user's own device first (lib/local-reading, lib/office-text): a PDF's
 * text (scanned pages by OCR), Word, Excel and PowerPoint files, and text in pictures. What was
 * read travels as text; nothing else of the file is sent. Only a PDF that couldn't be read
 * travels as base64, for a model that can see it (Gemini, when external files are allowed).
 * Images travel as base64 for vision, with any text read from them alongside. Text and code
 * files are read as text. Programs and other files nothing here can read aren't attached.
 *
 * This module is client-safe: no server imports.
 */

export type AttachmentKind = "image" | "pdf" | "audio" | "text" | "document" | "file";

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

/** Word, Excel and PowerPoint files, read as text on the device (lib/office-text). */
const DOCUMENT_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);

export function classifyAttachment(mime: string, name: string): AttachmentKind {
  const type = mime.toLowerCase();
  if (IMAGE_MIMES.has(type)) return "image";
  if (type === "application/pdf" || extensionOf(name) === "pdf") return "pdf";
  if (DOCUMENT_EXTENSIONS.has(extensionOf(name))) return "document";
  if (AUDIO_MIMES.has(type)) return "audio";
  if (type.startsWith("text/") || /json|xml|javascript|typescript|yaml|x-sh|sql/.test(type) || TEXT_EXTENSIONS.has(extensionOf(name))) return "text";
  return "file";
}

/** Programs and installers: never attached, whatever they're called. */
const EXECUTABLE_EXTENSIONS = new Set(("exe msi msix msixbundle appx appxbundle dll com scr cpl sys drv ocx efi apk aab xapk ipa app dmg pkg mpkg " +
  "deb rpm snap flatpak appimage run bin elf so dylib ko jar war ear class dex iso img vhd vhdx vmdk cab msu msp lnk url reg " +
  "vbs vbe wsf wsh hta jse gadget msc pif inf").split(" "));
const EXECUTABLE_MIMES = /x-msdownload|x-msdos-program|x-msi|portable-executable|x-executable|x-elf|x-mach-binary|x-sharedlib|java-archive|android\.package-archive|x-apple-diskimage|x-iso9660/;

export function isExecutable(mime: string, name: string) {
  return EXECUTABLE_EXTENSIONS.has(extensionOf(name)) || EXECUTABLE_MIMES.test(mime.toLowerCase());
}

/** The first bytes of a program (Windows, Linux, macOS, Java), whatever the file is named. */
export function looksExecutable(head: Uint8Array) {
  const [a, b, c, d] = head;
  if (a === 0x4d && b === 0x5a) return true; // MZ: Windows programs and libraries
  if (a === 0x7f && b === 0x45 && c === 0x4c && d === 0x46) return true; // ELF
  const magic = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
}

/**
 * Why a file can't be attached, or null when it can: programs are refused, and so is anything
 * that can't be read here (archives, videos, old .doc/.xls files) rather than sent along unread.
 */
export function refusalFor(mime: string, name: string, head?: Uint8Array): string | null {
  const label = name || "That file";
  if (isExecutable(mime, name) || (head && looksExecutable(head))) return `${label} is a program, so it wasn't attached.`;
  const extension = extensionOf(name);
  if (extension === "doc" || extension === "xls" || extension === "ppt") return `${label} is an old Office format she can't read. Save it as .${extension}x and attach that.`;
  if (classifyAttachment(mime, name) === "file") return `${label} isn't something she can read (pictures, PDFs, Word, Excel, PowerPoint, text and code files are), so it wasn't attached.`;
  return null;
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** The line the model reads in place of, or alongside, an attachment. */
export function attachmentNote(attachment: { name: string; kind: AttachmentKind; mime: string; size?: number }) {
  const label = attachment.kind === "image" ? "image" : attachment.kind === "pdf" ? "PDF" : attachment.kind === "audio" ? "audio" : attachment.kind === "document" ? "document" : "file";
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
    if (isExecutable(mime, name)) throw new AttachmentError(`${name} is a program, so it can't be sent.`);
    // What the device read from the file: a PDF's text, or the text in a picture.
    const read = typeof candidate.text === "string" && candidate.text.trim() ? candidate.text.slice(0, MAX_TEXT_ATTACHMENT_CHARS) : undefined;
    // A PDF read on their device arrives as its text alone; only one it couldn't read comes as bytes.
    if (kind === "pdf" && candidate.data === undefined && read) return { name, mime: "application/pdf", kind, text: read };
    if (kind === "image" || kind === "pdf" || kind === "audio") {
      const data = candidate.data;
      if (typeof data !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new AttachmentError(`${name} could not be read.`);
      const limit = kind === "image" ? MAX_IMAGE_DATA_CHARS : kind === "pdf" ? MAX_PDF_DATA_CHARS : MAX_AUDIO_DATA_CHARS;
      if (data.length > limit) throw new AttachmentError(`${name} is too large.`);
      return { name, mime: kind === "pdf" ? "application/pdf" : mime === "audio/x-wav" ? "audio/wav" : mime, kind, data, ...(read && kind === "image" ? { text: read } : {}) };
    }
    if (kind === "text" || kind === "document") {
      const text = typeof candidate.text === "string" ? candidate.text.slice(0, MAX_TEXT_ATTACHMENT_CHARS) : "";
      return { name, mime: mime || (kind === "text" ? "text/plain" : "application/octet-stream"), kind, text };
    }
    return { name, mime, kind };
  });
}
