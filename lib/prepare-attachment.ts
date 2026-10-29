/**
 * Turns a picked, pasted or dropped file into something a message can carry.
 *
 * Photos are downscaled in the browser before upload: a phone photo is 3-8 MB, and the model
 * gains nothing from more than ~1280px. Browser-only (canvas, FileReader).
 */

import {
  AttachmentError, classifyAttachment, MAX_AUDIO_DATA_CHARS, MAX_FILE_BYTES, MAX_IMAGE_DATA_CHARS, MAX_PDF_DATA_CHARS, formatBytes,
  type AttachmentMeta,
} from "@/lib/attachments";
import type { StoredAttachment } from "@/lib/attachment-store";

export type PreparedAttachment = { meta: AttachmentMeta; stored: StoredAttachment };

/** Other binary files are kept for re-download up to this size; larger ones keep only their name. */
const MAX_KEPT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_FILE_CHARS = 200_000;

function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

async function drawScaled(file: File, maxSide: number, quality: number) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot process images.");
    // JPEG has no transparency; a white ground keeps transparent screenshots legible.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    bitmap.close();
  }
}

export async function prepareAttachment(file: File, id: string): Promise<PreparedAttachment> {
  if (file.size > MAX_FILE_BYTES) throw new AttachmentError(`${file.name} is over ${formatBytes(MAX_FILE_BYTES)}.`);
  const kind = classifyAttachment(file.type, file.name);
  const name = file.name || "attachment";

  if (kind === "image") {
    let data = (await drawScaled(file, 1280, 0.85)).replace(/^data:[^,]*,/, "");
    if (data.length > MAX_IMAGE_DATA_CHARS) data = (await drawScaled(file, 960, 0.72)).replace(/^data:[^,]*,/, "");
    if (data.length > MAX_IMAGE_DATA_CHARS) throw new AttachmentError(`${name} is too detailed to send.`);
    const thumb = await drawScaled(file, 180, 0.62);
    return {
      meta: { id, name, mime: "image/jpeg", size: Math.round((data.length * 3) / 4), kind, thumb },
      stored: { data },
    };
  }
  if (kind === "audio") {
    const data = await readAsBase64(file);
    if (data.length > MAX_AUDIO_DATA_CHARS) throw new AttachmentError(`${name} is too long; audio up to about 2 MB can be heard.`);
    return { meta: { id, name, mime: file.type === "audio/x-wav" ? "audio/wav" : file.type, size: file.size, kind }, stored: { data } };
  }
  if (kind === "pdf") {
    const data = await readAsBase64(file);
    if (data.length > MAX_PDF_DATA_CHARS) throw new AttachmentError(`${name} is too large; PDFs up to about 3 MB can be read.`);
    return { meta: { id, name, mime: "application/pdf", size: file.size, kind }, stored: { data } };
  }
  if (kind === "text") {
    const text = (await file.text()).slice(0, MAX_TEXT_FILE_CHARS);
    return { meta: { id, name, mime: file.type || "text/plain", size: file.size, kind }, stored: { text } };
  }
  const stored = file.size <= MAX_KEPT_FILE_BYTES ? { data: await readAsBase64(file) } : {};
  return { meta: { id, name, mime: file.type || "application/octet-stream", size: file.size, kind }, stored };
}
