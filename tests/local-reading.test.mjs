import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { officeKind, officeText, OfficeReadError, unzipText, xmlText } from "../lib/office-text.ts";
import { AttachmentError, classifyAttachment, looksExecutable, parseWireAttachments, refusalFor } from "../lib/attachments.ts";

/** A minimal ZIP (what DOCX, XLSX and PPTX are), deflated like Office writes them. */
function zip(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(text);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, Buffer.from(nameBytes), data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, Buffer.from(nameBytes));
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

test("Word: paragraphs, tabs, breaks and tables come out as readable text", async () => {
  const document = `<w:document><w:body>
    <w:p><w:r><w:t>Dear Freya,</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Rent is </w:t></w:r><w:r><w:t>&#8377;12,000 &amp; due</w:t></w:r><w:r><w:br/><w:t>on the 5th.</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cost</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`;
  const text = await officeText(zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": document }), "docx");
  assert.match(text, /^Dear Freya,\nRent is ₹12,000 & due\non the 5th\./);
  assert.match(text, /Item/);
  assert.match(text, /Cost/);
});

test("Excel: every sheet by name, shared strings, numbers, gaps kept, long sheets cut", async () => {
  const files = {
    "xl/workbook.xml": `<workbook><sheets><sheet name="Budget &amp; bills" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst><si><t>Rent</t></si><si><r><t>Phone</t></r><r><t xml:space="preserve"> bill</t></r></si></sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>12000</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="b"><v>1</v></c></row></sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>call landlord</t></is></c></row></sheetData></worksheet>`,
  };
  const text = await officeText(zip(files), "xlsx");
  assert.match(text, /\[Sheet: Budget & bills\]\nRent\t\t12000\nPhone bill\tTRUE/);
  assert.match(text, /\[Sheet: Notes\]\ncall landlord/);
  const rows = Array.from({ length: 250 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`).join("");
  const long = await officeText(zip({ ...files, "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${rows}</sheetData></worksheet>` }), "xlsx");
  assert.match(long, /\[50 more rows not shown\]/);
});

test("PowerPoint: slides in order", async () => {
  const slide = (text) => `<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
  const text = await officeText(zip({ "ppt/slides/slide10.xml": slide("Ten"), "ppt/slides/slide2.xml": slide("Two") }), "pptx");
  assert.ok(text.indexOf("Two") < text.indexOf("Ten"));
  assert.match(text, /\[Slide 2\]\nTwo/);
});

test("broken or protected files fail plainly instead of sending junk", async () => {
  await assert.rejects(officeText(new Uint8Array([1, 2, 3, 4]), "docx"), OfficeReadError);
  await assert.rejects(officeText(zip({ "EncryptedPackage": "x" }), "docx"), /password-protected/);
  const stored = await unzipText(zip({ "a.txt": "hello" }), () => true);
  assert.equal(stored.get("a.txt"), "hello");
  assert.equal(xmlText("&lt;b&gt; &#x1F600; &unknown;"), "<b> 😀 &unknown;");
  assert.equal(officeKind("Report.DOCX"), "docx");
  assert.equal(officeKind("old.doc"), null);
});

test("programs and unreadable files are refused; what's read on the device travels as text", () => {
  assert.equal(classifyAttachment("", "plan.xlsx"), "document");
  assert.match(refusalFor("application/x-msdownload", "setup.exe"), /program/);
  assert.match(refusalFor("", "game.apk"), /program/);
  assert.match(refusalFor("image/png", "cat.png", new Uint8Array([0x4d, 0x5a, 0x90, 0])), /program/, "a renamed program is still a program");
  assert.match(refusalFor("application/zip", "photos.zip"), /isn't something she can read/);
  assert.match(refusalFor("application/msword", "cv.doc"), /\.docx/);
  assert.equal(refusalFor("application/pdf", "cv.pdf"), null);
  assert.equal(refusalFor("text/x-python", "main.py"), null, "code is read as text, not run");
  assert.equal(looksExecutable(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])), true);
  assert.equal(looksExecutable(new Uint8Array([0x25, 0x50, 0x44, 0x46])), false, "%PDF");
  // A PDF read on the device: text only, no bytes.
  const [pdf] = parseWireAttachments([{ name: "cv.pdf", mime: "application/pdf", text: "[Page 1]\nJane Doe" }]);
  assert.deepEqual(pdf, { name: "cv.pdf", mime: "application/pdf", kind: "pdf", text: "[Page 1]\nJane Doe" });
  // One it couldn't read still needs its bytes.
  assert.throws(() => parseWireAttachments([{ name: "scan.pdf", mime: "application/pdf" }]), AttachmentError);
  const [sheet] = parseWireAttachments([{ name: "plan.xlsx", mime: "", text: "[Sheet: A]\n1" }]);
  assert.equal(sheet.kind, "document");
  const [picture] = parseWireAttachments([{ name: "note.png", mime: "image/png", data: "iVBORw0KGgo=", text: "buy milk and eggs please" }]);
  assert.equal(picture.text, "buy milk and eggs please", "a picture's own text rides along with it");
  assert.throws(() => parseWireAttachments([{ name: "x.exe", mime: "application/octet-stream", text: "MZ" }]), AttachmentError);
});
