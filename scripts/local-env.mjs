// .env handling shared by setup.mjs and start.mjs. Plain Node, no dependencies.
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const root = join(import.meta.dirname, "..");

/** KEY=value pairs from .env then .env.local (local wins), as Next.js loads them. */
export function readEnv() {
  const values = {};
  for (const file of [".env", ".env.local"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return values;
}

export const isSet = (value) => Boolean(value) && !/^(replace_me|your_|YOUR_)/.test(value);

/**
 * Creates .env.local from .env.example when it doesn't exist. Returns true if it was created.
 * On your own machine there's no hosting edge to identify visitors, so the single-owner mode
 * is what makes chat work out of the box. Never for a public deployment.
 */
export function ensureEnvLocal() {
  const local = join(root, ".env.local");
  if (existsSync(local)) return false;
  copyFileSync(join(root, ".env.example"), local);
  appendFileSync(local, "\n# Added by setup: running on your own machine.\nFREYA_SELF_HOSTED=true\n");
  return true;
}
