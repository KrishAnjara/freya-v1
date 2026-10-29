/**
 * Does this message need real reasoning, or is it conversation?
 *
 * Shared by the chat route (to convene the reasoning panel, lib/council) and the browser (to
 * show "thinking it through" while the panel works). Pure, no imports, so both can use it.
 * Deliberately conservative: casual chat must stay fast, so only clear signals count.
 */

export type ReasoningMode = "auto" | "always" | "off";

export function isReasoningMode(value: unknown): value is ReasoningMode {
  return value === "auto" || value === "always" || value === "off";
}

/** Signals strong enough on their own: maths, code, formal logic, explicit requests to think. */
const STRONG = [
  /\d\s*[-+*/×÷^%]\s*\(?\d/, // arithmetic in the message
  /\b(calculate|compute|solve|equation|integral|derivative|probability|odds of|percentage|compound interest|statistics?|proof|prove|theorem)\b/i,
  /```|\b(debug|algorithm|time complexity|big[- ]o|regex|sql query|stack trace|traceback|exception|segfault|refactor)\b/i,
  /\b(riddle|logic puzzle|paradox|syllogism|brain ?teaser)\b/i,
  /\b(step[- ]by[- ]step|think (it )?through|think hard|reason (it )?out|walk me through|show (your|the) (work|working|steps))\b/i,
];

/** Weaker signals: two of these, or one in a long message, make it worth the panel. */
const WEAK = [
  /\b(why|how come|how does|how do .* work|explain)\b/i,
  /\b(compare|comparison|versus|vs\.?|difference between|pros and cons|trade-?offs?|which (is|one is) better)\b/i,
  /\b(should i|what would you do|decide|decision|plan|strategy|optimi[sz]e|best way|most efficient)\b/i,
  /\b(analy[sz]e|evaluate|assess|estimate|predict|design|architecture|implications?|consequences?)\b/i,
  /\b(if .+ then|what happens if|suppose|assume|given that)\b/i,
];

/** Messages that are clearly conversation, whatever words they contain. */
const CASUAL = /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|lol|lmao|haha|gm|gn|good (morning|night))\b[\s!.?]*$/i;

export function needsReasoning(text: string, mode: ReasoningMode = "auto"): boolean {
  if (mode === "off") return false;
  const value = text.trim();
  if (value.length < 12 || CASUAL.test(value)) return false;
  if (mode === "always") return true;
  if (STRONG.some((pattern) => pattern.test(value))) return true;
  const weak = WEAK.filter((pattern) => pattern.test(value)).length;
  return weak >= 2 || (weak === 1 && value.length > 220);
}

/** Questions where outside evidence beats memory: comparisons of real things, numbers, specs. */
export function wantsEvidence(text: string): boolean {
  return /\b(vs\.?|versus|compare|comparison|best|top \d+|benchmark|specs?|price|cost|statistics|data on|according to|latest|current|this year|in 20\d\d)\b/i.test(text);
}
