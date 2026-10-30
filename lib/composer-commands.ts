/**
 * Composer shortcuts. "/visualize …" makes a new 3D form on the canvas and "/image …" makes a
 * picture in the chat; neither is sent to FREYA as an ordinary message. A plain request for a
 * picture ("draw me a cat") is recognised too, conservatively. Changing a form isn't a command:
 * its card's Refine button tags it in the composer. Pure, so it is tested directly.
 */
export type ComposerCommand = { name: "visualize" | "image"; argument: string };

export const COMMANDS = [
  { name: "visualize", usage: "/visualize a red fox", hint: "Make a new 3D particle form on the canvas" },
  { name: "image", usage: "/image a lighthouse at night", hint: "Make a picture in the chat" },
] as const;

const ALIASES: Record<string, ComposerCommand["name"]> = { visualize: "visualize", visualise: "visualize", viz: "visualize", image: "image", img: "image", draw: "image" };

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

const VERB = /^(?:(?:can|could|would|will) you\s+|please\s+|pls\s+|hey freya,?\s+|freya,?\s+)*(?:draw|paint|sketch|generate|create|make|send|show) (?:me |us )?(?:a |an |the |some )?(?:quick |little |cute |new )?(?:picture|image|pic|photo|drawing|painting|sketch|illustration|portrait|render)s? of\s+(.{2,300})$/i;
const DIRECT_DRAW = /^(?:(?:can|could|would|will) you\s+|please\s+|pls\s+)*(?:draw|paint|sketch) (?:me |us )?(.{2,300})$/i;

/**
 * "draw me a fox", "can you make a picture of a castle?" → "a fox", "a castle".
 * Only clear requests count: "draw conclusions" or "a picture of health" style phrases rarely
 * start a message this way, and anything ambiguous stays a normal chat message.
 */
export function pictureRequest(text: string): string | null {
  const clean = text.trim().replace(/[?!.]+$/, "");
  if (clean.length > 320 || /\n/.test(clean)) return null;
  const match = clean.match(VERB) ?? clean.match(DIRECT_DRAW);
  if (!match) return null;
  const subject = match[1].trim();
  if (/^(conclusions?|the line|attention|a blank|breath|straws?|up a plan|from|on (your|my) experience)\b/i.test(subject)) return null;
  return subject;
}
