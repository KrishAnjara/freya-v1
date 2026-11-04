/**
 * Reading files on the user's own device, before anything is sent (lib/prepare-attachment):
 *
 *   PDF      its text, page by page (pdf.js). Pages with no text on them (a scan, a photo of a
 *            page) are rendered and read by OCR.
 *   Pictures any text in them (a screenshot, a receipt, a page of notes), by OCR: Tesseract,
 *            running in a web worker so the page stays responsive.
 *   Office   DOCX, XLSX and PPTX (lib/office-text).
 *
 * pdf.js and Tesseract load only when a file needs them. Tesseract fetches its English model (a
 * few MB) the first time and the browser keeps it; the file itself never leaves the device. When
 * reading fails the caller falls back: a PDF's bytes go to the server for a model that can see it
 * (Gemini), only if external file processing is allowed there. Browser-only.
 */
import type { Worker as OcrWorker } from "tesseract.js";

/** Pages read from a PDF; past this, the rest are left out (and the reply says so). */
const MAX_PDF_PAGES = 60;
/** Scanned pages read by OCR, each a few seconds of work on a laptop CPU. */
const MAX_OCR_PAGES = 5;
const OCR_PAGE_TIMEOUT_MS = 45_000;
/** Below this Tesseract is mostly guessing (a photo with no writing in it), so the text is dropped. */
const MIN_CONFIDENCE = 55;
/** The OCR worker is kept for the next picture, then let go so it doesn't hold memory. */
const OCR_IDLE_MS = 3 * 60_000;

const tidy = (text: string) => text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

let ocrWorker: Promise<OcrWorker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

async function releaseOcr() {
  const worker = ocrWorker;
  ocrWorker = null;
  if (worker) await worker.then((ready) => ready.terminate()).catch(() => undefined);
}

/** Text in an image, or "" when there's none worth having. */
export async function ocrText(image: HTMLCanvasElement | Blob, timeoutMs = OCR_PAGE_TIMEOUT_MS): Promise<string> {
  clearTimeout(idleTimer);
  ocrWorker ??= import("tesseract.js").then(({ createWorker }) => createWorker("eng"));
  try {
    const worker = await withTimeout(ocrWorker, timeoutMs);
    const { data } = await withTimeout(worker.recognize(image), timeoutMs);
    const text = tidy(data.text ?? "");
    return data.confidence >= MIN_CONFIDENCE && letters(text) >= 12 ? text : "";
  } catch {
    // A worker stuck on a page is no use for the next one.
    await releaseOcr();
    return "";
  } finally {
    idleTimer = setTimeout(() => void releaseOcr(), OCR_IDLE_MS);
  }
}

type TextItem = { str?: string; hasEOL?: boolean };

/** A PDF's text, with scanned pages read by OCR. Throws when the file can't be opened. */
export async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number; read: number; scanned: number }> {
  const pdfjs = await import("pdfjs-dist");
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  }
  // pdf.js takes ownership of the buffer it's given, so it gets a copy.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  try {
    const read = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const pages: string[] = [];
    const blank: number[] = [];
    for (let number = 1; number <= read; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = tidy((content.items as TextItem[]).map((item) => `${item.str ?? ""}${item.hasEOL ? "\n" : ""}`).join(""));
      pages.push(text);
      if (letters(text) < 20) blank.push(number);
      page.cleanup();
    }
    let scanned = 0;
    for (const number of blank.slice(0, MAX_OCR_PAGES)) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const text = await ocrText(canvas);
      canvas.width = canvas.height = 0;
      page.cleanup();
      if (text) { pages[number - 1] = text; scanned += 1; }
    }
    const body = pages.map((text, index) => text ? `[Page ${index + 1}]\n${text}` : "").filter(Boolean).join("\n\n");
    const rest = pdf.numPages > read ? `\n\n[${pdf.numPages - read} more pages not read]` : "";
    const unread = blank.length > MAX_OCR_PAGES ? `\n[${blank.length - MAX_OCR_PAGES} scanned pages not read]` : "";
    return { text: body ? body + rest + unread : "", pages: pdf.numPages, read, scanned };
  } finally {
    await task.destroy();
  }
}
