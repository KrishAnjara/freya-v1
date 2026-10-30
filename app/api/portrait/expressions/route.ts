import { NextResponse } from "next/server";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { EXPRESSION_FILE } from "@/lib/expression";

/**
 * Which expression images actually exist in public/portrait/expressions/, so the portrait
 * never requests a file that isn't there. Only names matching EXPRESSION_FILE are listed.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const files = await readdir(join(process.cwd(), "public", "portrait", "expressions"));
    const images = files
      .map((file) => file.match(EXPRESSION_FILE))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => ({ expression: match[1].toLowerCase(), url: `/portrait/expressions/${match[0]}` }))
      .sort((a, b) => a.url.localeCompare(b.url));
    return NextResponse.json({ images }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // No folder yet: every expression stays procedural on the base portrait.
    return NextResponse.json({ images: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}
