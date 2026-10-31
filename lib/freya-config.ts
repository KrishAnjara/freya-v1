/**
 * freya.config.json: FREYA's on/off switches, in one file. Read fresh when it changes, so an edit
 * applies to her next message with no restart. A switch that's missing from the file is left to
 * Settings in the browser. `freya` (scripts/freya.mjs) flips them from a menu or a command.
 *
 * Only known switches are read, so nothing else in the file can change anything. The hard limits
 * (lib/reply-guard, lib/intimacy, lib/honesty) are deliberately not switches.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SWITCHES = ["sexTalk", "swearing", "unhinged", "stayInCharacter", "realisticTiming", "textsFirst", "replyChecks", "rateLimit", "thinking"] as const;
export type FreyaConfig = Partial<Record<(typeof SWITCHES)[number], boolean>>;

const asSwitch = (value: unknown) => value === true || value === "on" ? true : value === false || value === "off" ? false : undefined;

export function parseConfig(text: string): FreyaConfig {
  let values: unknown;
  try {
    values = JSON.parse(text);
  } catch {
    console.warn("freya.config.json isn't valid JSON, so it's being ignored. Run `freya` to see what it should look like.");
    return {};
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) return {};
  const config: FreyaConfig = {};
  for (const name of SWITCHES) {
    const value = asSwitch((values as Record<string, unknown>)[name]);
    if (value !== undefined) config[name] = value;
  }
  return config;
}

let cached: { key: string; config: FreyaConfig } | null = null;

export function loadConfig(): FreyaConfig {
  const path = process.env.FREYA_CONFIG_PATH || join(process.cwd(), "freya.config.json");
  try {
    const { mtimeMs, size } = statSync(path);
    const key = `${path}:${mtimeMs}:${size}`;
    if (cached?.key !== key) cached = { key, config: parseConfig(readFileSync(path, "utf8")) };
    return cached.config;
  } catch {
    return {};
  }
}
