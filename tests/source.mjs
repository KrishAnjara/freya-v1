import { readFile } from "node:fs/promises";

/**
 * app/page.tsx as one line of code, the same however it's formatted: the source tests match
 * patterns like `planEnqueue(job, …, thread)`, and a formatter that wraps calls over several lines
 * (with trailing commas) shouldn't break them.
 */
export async function readPage() {
  const text = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  return text
    .replace(/\s+/g, " ")
    .replace(/([([]) (?=\S)/g, "$1")
    .replace(/,? ([)\]])/g, "$1")
    .replace(/, \}/g, " }");
}
