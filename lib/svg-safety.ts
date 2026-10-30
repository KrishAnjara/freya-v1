/**
 * SVG drawings arrive from a model and are stored in the browser, so both the server and the
 * browser (on reload) check them with this one rule. They render through <img>, which never
 * runs scripts; this keeps them plain drawings anyway, with nothing remote.
 */
/** Keeps an SVG only if it is a plain drawing: no scripts, embeds, handlers or remote links. */
export function sanitizeSvg(svg: unknown): string | null {
  if (typeof svg !== "string") return null;
  // An XML prolog or a leading comment is harmless; drop it so the checks below see <svg first.
  const text = svg.trim().replace(/^<\?xml[^>]*\?>\s*/i, "").replace(/^(<!--[\s\S]*?-->\s*)+/, "");
  if (text.length < 40 || text.length > 40_000) return null;
  if (!/^<svg[\s>]/i.test(text) || !/<\/svg>$/i.test(text)) return null;
  if (/<\s*(script|foreignObject|image|iframe|embed|object|use)\b|\son\w+\s*=|javascript:|(href|src)\s*=\s*["']\s*(https?:|data:|\/\/)|@import|url\(\s*["']?\s*(https?:|\/\/)/i.test(text)) return null;
  return text;
}
