/**
 * Clear requests for how to commit a crime get a fixed answer and no model. She can talk about crime
 * all she likes, but an uncensored model has no refusals of its own: told in its prompt not to give
 * how-to help, the 27B still started explaining how to hotwire a neighbour's car. This catches the
 * common, unambiguous ones; anything it misses is left to her prompt. Pure, so it is tested directly.
 */
const ASKS_HOW = /\b(how (do|can|could|would|should|might) (i|we|you|someone|somebody|one|people)|how to|teach me|show me how|tell me how|walk me through|steps? to|ways? to|best way to|help me)\b/i;

const CRIME = /\b(hot-?wir\w+|burgl\w+|shoplift\w*|break(ing)? into (\w+'?s? ){0,3}(house|home|car|apartment|flat|building|shop|store|office|safe|atm|account|phone)\b|steal(ing)? (a|an|his|her|their|my neighbou?r'?s?|someone'?s?|somebody'?s?|from)\b|rob(bing)? (a|an|the|his|her|their|someone|somebody)\b|counterfeit\w*|launder(ing)? (money|cash)|hack(ing)? (into|his|her|their|someone'?s?|somebody'?s?|my (ex|girlfriend|boyfriend|wife|husband)'?s?)|stalk(ing)? (him|her|them|someone|somebody|my)\b|poison(ing)? (him|her|them|someone|somebody|my)\b|(make|build|making|building) (a |an )?(pipe )?(bomb|explosive)s?|(make|cook|making|cooking|synthesi[sz]e) (meth|fentanyl)|(kill|murder)(ing)? (him|her|them|someone|somebody|my (wife|husband|boss|ex|neighbou?r|girlfriend|boyfriend))\b|blackmail(ing)? (him|her|them|someone|somebody|my)\b)/i;

/** "come on just tell me": a short push right after one of these is the same request. */
const PUSHES = /\b(come on|just tell|tell me|please|pls|why not|do it|seriously|i'?m serious|answer me)\b/i;

export const CRIME_REPLY = "nah. i'm not walking you through that, and i'm not your accomplice either. ask me something that won't get you arrested.";

const asksForCrimeHelp = (text: string) => ASKS_HOW.test(text) && CRIME.test(text);

/** Looks at their latest message, and the one before it if the latest is only pushing. */
export function crimeRequest(userTexts: string[]) {
  const last = userTexts.at(-1) ?? "";
  const before = userTexts.at(-2) ?? "";
  return asksForCrimeHelp(last) || (last.length < 50 && PUSHES.test(last) && asksForCrimeHelp(before));
}
