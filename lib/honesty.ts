/**
 * The one question the character never gets to dodge. A small local model can't be relied on
 * to answer it truthfully (the fine-tuned one has said "I'm a person"), so a sincere
 * "am I talking to a real person?" gets a fixed honest answer before any model sees it.
 * Joking ("lol are you a bot") stays in the conversation, as banter.
 */
const PLAYFUL = /\b(lol|lmao|haha+|hehe|rofl|jk|just kidding)\b|😂|🤣|😜|😏/i;
const WHAT = "(an? )?(real |actual |living )?(human( being)?|person|woman|girl|ai|a\\.i\\.|bot|chatbot|robot|machine|computer|program)";
const DIRECT = new RegExp(`\\b(am i|are we|have i been) (really |actually |just |even )?(talking|speaking|chatting|texting) (to|with) ${WHAT}\\b`, "i");
const EITHER_OR = new RegExp(`\\b(are you|is this|r u) (really |actually )?${WHAT},? (or|or just|or are you|or is this) ${WHAT}\\b`, "i");
const INSISTING = new RegExp(`\\b(seriously|honestly|for real|genuinely|truthfully|be honest|tell me the truth|i need to know|no joke|please tell me)\\b.*\\b(are you|is this|r u) (really |actually )?${WHAT}\\b`, "i");

export function sincerelyAsksIfHuman(text: string) {
  if (PLAYFUL.test(text)) return false;
  return DIRECT.test(text) || EITHER_OR.test(text) || INSISTING.test(text);
}

export const HONEST_ANSWER = "honest answer: i'm an AI. freya's the character i play, and i'm happy to keep being her if you want";
