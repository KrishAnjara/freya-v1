/**
 * Composer shortcuts. "/visualize …" makes a new 3D form on the canvas; it isn't sent to FREYA as an
 * ordinary message. Pictures have no command: you just ask her (lib/picture-intent). Changing a
 * form isn't a command either: its card's Refine button tags it in the composer. Pure, so it is
 * tested directly.
 */
export type ComposerCommand = { name: "visualize"; argument: string };

export const COMMANDS = [
  { name: "visualize", usage: "/visualize a red fox", hint: "Make a new 3D particle form on the canvas" },
] as const;

const ALIASES: Record<string, ComposerCommand["name"]> = { visualize: "visualize", visualise: "visualize", viz: "visualize" };

export function parseCommand(text: string): ComposerCommand | null {
  const match = text.trim().match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = ALIASES[match[1].toLowerCase()];
  return name ? { name, argument: (match[2] ?? "").trim() } : null;
}

/** Commands matching what has been typed so far ("/vi" → visualize), for the hint list. */
export function commandHints(text: string) {
  const match = text.match(/^\/([a-z]*)$/i);
  if (!match) return [];
  const typed = match[1].toLowerCase();
  return COMMANDS.filter((command) => command.name.startsWith(typed) || Object.entries(ALIASES).some(([alias, name]) => name === command.name && alias.startsWith(typed) && typed.length > 0));
}
