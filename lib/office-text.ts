/**
 * Text out of Word, Excel and PowerPoint files (DOCX, XLSX, PPTX), read on the user's own device.
 *
 * These files are ZIP archives of XML. The archive is read here and each entry inflated with the
 * platform's own DecompressionStream, so there's no library and nothing leaves the browser; then
 * the text is picked out of the XML. Pure apart from DecompressionStream (in every current
 * browser, and in Node), so it is tested directly.
 */

export class OfficeReadError extends Error {}

const UINT16 = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8);
const UINT32 = (bytes: Uint8Array, at: number) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Entries of a ZIP whose names pass `wanted`, as text. Stored and deflated entries; nothing else. */
export async function unzipText(bytes: Uint8Array, wanted: (name: string) => boolean, maxEntryBytes = 20 * 1024 * 1024): Promise<Map<string, string>> {
  // The end-of-central-directory record is in the last 64 KB (it can carry a comment).
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at -= 1) {
    if (UINT32(bytes, at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new OfficeReadError("not a ZIP archive");
  const count = UINT16(bytes, end + 10);
  let at = UINT32(bytes, end + 16);
  const out = new Map<string, string>();
  const decoder = new TextDecoder("utf-8");
  for (let index = 0; index < count && at + 46 <= bytes.length; index += 1) {
    if (UINT32(bytes, at) !== 0x02014b50) throw new OfficeReadError("damaged ZIP directory");
    const flags = UINT16(bytes, at + 8);
    const method = UINT16(bytes, at + 10);
    const compressed = UINT32(bytes, at + 20);
    const size = UINT32(bytes, at + 24);
    const nameLength = UINT16(bytes, at + 28);
    const extraLength = UINT16(bytes, at + 30);
    const commentLength = UINT16(bytes, at + 32);
    const local = UINT32(bytes, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name) || flags & 1 || size > maxEntryBytes) continue; // encrypted or huge: skipped
    if (UINT32(bytes, local) !== 0x04034b50) throw new OfficeReadError("damaged ZIP entry");
    const start = local + 30 + UINT16(bytes, local + 26) + UINT16(bytes, local + 28);
    const raw = bytes.subarray(start, start + compressed);
    const data = method === 0 ? raw : method === 8 ? await inflate(raw) : null;
    if (data) out.set(name, decoder.decode(data));
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
export function xmlText(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const tidy = (text: string) => text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Word: paragraphs as lines, tabs and line breaks kept, table cells separated by " | ". */
export function docxText(documentXml: string) {
  let out = "";
  const tokens = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<\/w:p>|<\/w:tc>|<\/w:tr>/g;
  for (const match of documentXml.matchAll(tokens)) {
    if (match[1] !== undefined) out += xmlText(match[1]);
    else if (match[0] === "<w:tab/>") out += "\t";
    else if (match[0].startsWith("<w:br")) out += "\n";
    else if (match[0] === "</w:tc>") out += " | ";
    else out += "\n";
  }
  return tidy(out.replace(/ \| \n/g, "\n"));
}

/** PowerPoint: each slide's text, in slide order. */
export function pptxText(slides: Map<string, string>) {
  const ordered = [...slides.entries()]
    .map(([name, xml]) => ({ number: Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0), xml }))
    .sort((a, b) => a.number - b.number);
  return tidy(ordered.map(({ number, xml }) => {
    let text = "";
    for (const match of xml.matchAll(/<a:t>([^<]*)<\/a:t>|<\/a:p>/g)) text += match[1] !== undefined ? xmlText(match[1]) : "\n";
    return `[Slide ${number}]\n${tidy(text)}`;
  }).join("\n\n"));
}

/** "AB" → 27 (A = 1). */
function columnNumber(reference: string) {
  let number = 0;
  for (const letter of reference.toUpperCase().match(/^[A-Z]+/)?.[0] ?? "") number = number * 26 + letter.charCodeAt(0) - 64;
  return number;
}

/** Excel: each sheet as tab-separated rows, with its name; at most `maxRows` rows a sheet. */
export function xlsxText(files: Map<string, string>, maxRows = 200) {
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((item) => [...item[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((run) => xmlText(run[1])).join(""));
  const rels = new Map([...(files.get("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)].map((tag) => [
    tag[0].match(/\bId="([^"]+)"/)?.[1] ?? "",
    (tag[0].match(/\bTarget="([^"]+)"/)?.[1] ?? "").replace(/^\/?(xl\/)?/, "xl/"),
  ]));
  const sheets = [...(files.get("xl/workbook.xml") ?? "").matchAll(/<sheet\b[^>]*>/g)].map((tag) => ({
    name: xmlText(tag[0].match(/\bname="([^"]*)"/)?.[1] ?? "Sheet"),
    path: rels.get(tag[0].match(/\br:id="([^"]+)"/)?.[1] ?? "") ?? "",
  }));
  // A workbook without the usual index still has its sheets.
  const listed = sheets.length ? sheets : [...files.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort().map((path, index) => ({ name: `Sheet${index + 1}`, path }));
  const parts: string[] = [];
  for (const sheet of listed) {
    const xml = files.get(sheet.path);
    if (!xml) continue;
    const rows: string[] = [];
    let more = 0;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) { more += 1; continue; }
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1];
        const body = cell[2] ?? "";
        const column = columnNumber(attributes.match(/\br="([A-Z]+)\d*"/)?.[1] ?? "") || cells.length + 1;
        const type = attributes.match(/\bt="([^"]+)"/)?.[1];
        const value = body.match(/<v>([^<]*)<\/v>/)?.[1];
        const text = type === "s" ? shared[Number(value)] ?? ""
          : type === "inlineStr" ? [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((run) => xmlText(run[1])).join("")
            : type === "b" ? (value === "1" ? "TRUE" : "FALSE")
              : xmlText(value ?? "");
        while (cells.length < column - 1) cells.push("");
        cells[column - 1] = text.replace(/[\t\r\n]+/g, " ");
      }
      if (cells.some((cell) => cell.trim())) rows.push(cells.join("\t").replace(/\t+$/, ""));
    }
    if (rows.length) parts.push(`[Sheet: ${sheet.name}]\n${rows.join("\n")}${more ? `\n[${more} more rows not shown]` : ""}`);
  }
  return parts.join("\n\n");
}

export type OfficeKind = "docx" | "xlsx" | "pptx";

export function officeKind(name: string): OfficeKind | null {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension === "docx" || extension === "xlsx" || extension === "pptx" ? extension : null;
}

/** The text of an Office file. Throws OfficeReadError when it isn't one, or is protected. */
export async function officeText(bytes: Uint8Array, kind: OfficeKind): Promise<string> {
  if (kind === "docx") {
    const files = await unzipText(bytes, (name) => name === "word/document.xml");
    const xml = files.get("word/document.xml");
    if (!xml) throw new OfficeReadError("no document inside (is it password-protected?)");
    return docxText(xml);
  }
  if (kind === "pptx") {
    const files = await unzipText(bytes, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    if (!files.size) throw new OfficeReadError("no slides inside (is it password-protected?)");
    return pptxText(files);
  }
  const files = await unzipText(bytes, (name) => name === "xl/workbook.xml" || name === "xl/sharedStrings.xml" || name === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (![...files.keys()].some((name) => name.startsWith("xl/worksheets/"))) throw new OfficeReadError("no sheets inside (is it password-protected?)");
  return xlsxText(files);
}
