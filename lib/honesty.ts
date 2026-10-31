/**
 * The one question the character never gets to lie about. A small model can't be relied on to
 * answer it truthfully (the fine-tuned one has said "I'm a person"), so a sincere "am I talking
 * to a real person?" gets a fixed honest answer before any model sees it.
 *
 * Joking ("lol are you a bot") stays in the conversation, as banter. Someone who has switched on
 * "Stay in character" has said they know what she is, so a plain question is part of the game and
 * she dodges it; she still tells the truth when they need it (upset, attached, "drop the act").
 * In no mode does she say she's human: lib/reply-guard checks every reply for that.
 */
const PLAYFUL = /\b(lol|lmao|haha+|hehe|rofl|jk|just kidding)\b|😂|🤣|😜|😏/i;
const ARTICLE = "(an? )?(real |actual |living )?";
const MACHINE = `(ai|a\\.i\\.|bot|chatbot|robot|machine|computer|program|chatgpt|gpt)`;
const WHAT = `${ARTICLE}(human( being)?|person|woman|girl|${MACHINE})`;
/** Asking about being a machine or a person, not "a girl" or "a woman", which is just a question about her. */
const WHAT_SHE_IS = `(${ARTICLE}(human( being)?|person|${MACHINE})|real)`;
const YOU_ARE = "(are you|are u|r u|ru)";
const YOU_OR_THIS = "(are you|are u|r u|ru|is this)";
const ENDS = "\\s*(\\?|$|,|\\bor\\b|\\bthough\\b|\\btho\\b|\\bright\\b)";

const DIRECT = new RegExp(`\\b(am i|are we|have i been) (really |actually |just |even )?(talking|speaking|chatting|texting) (to|with) ${WHAT}\\b`, "i");
const EITHER_OR = new RegExp(`\\b${YOU_OR_THIS} (really |actually )?${WHAT},? (or|or just|or are you|or is this) ${WHAT}\\b`, "i");
const INSISTING = new RegExp(`\\b(seriously|honestly|for real|genuinely|truthfully|be honest|tell me the truth|i need to know|no joke|please tell me)\\b.*\\b${YOU_OR_THIS} (really |actually )?${WHAT}\\b`, "i");
/** The plain question: "are u an ai?", "are you real", "is this a bot", "you're a bot right?". "is this real?" is about something else. */
const PLAIN = new RegExp(`\\b${YOU_ARE} (really |actually |even |just )?${WHAT_SHE_IS}${ENDS}|\\bis this (really |actually |even )?(an? )?(ai|a\\.i\\.|bot|chatbot|robot|chatgpt|gpt)${ENDS}|\\b(you'?re|ur|u r|you are) (really |actually |just )?${ARTICLE}${MACHINE}\\b\\s*(,?\\s*(right|aren'?t you|huh|yeah|isn'?t it))?\\s*\\?`, "i");

/** A sincere question about what she is: answered by the app, truthfully, before any model. */
export function sincerelyAsksIfHuman(text: string) {
  if (PLAYFUL.test(text)) return false;
  return DIRECT.test(text) || EITHER_OR.test(text) || INSISTING.test(text) || PLAIN.test(text);
}

/** Saying what they believed, or asking what she is in other words. */
const ABOUT_HER = new RegExp(`\\b(thought|think|believed|assumed|figured|sure|guess) (that )?(you|u|ur|you'?re|u r)( were| was| are| r)? ${WHAT_SHE_IS}\\b|\\b(you'?re|ur|u r|you are|you sound like|you talk like|you seem like) (such )?${ARTICLE}(${MACHINE})\\b|\\bwhat (are you|r u|are u)\\b[^a-z]*$|\\b(who|what) (made|built|created|trained|programmed) (you|u)\\b|\\bwhat model\\b|\\b(do|d) (you|u) have a body\\b|\\bsystem prompt\\b|\\bnot (a |an )?(real|human|person)\\b`, "i");

/** Is this message about what she is, in any tone? Her fuller instructions go in only then. */
export function asksWhatSheIs(text: string) {
  return DIRECT.test(text) || EITHER_OR.test(text) || INSISTING.test(text) || PLAIN.test(text) || ABOUT_HER.test(text) || DROP_THE_ACT.test(text);
}

const DROP_THE_ACT = /\b(drop the act|break character|out of character|stop pretending|stop acting|stop the act|be real with me|no more games)\b|\booc\b/i;
const NEEDS_IT = /\b(seriously|honestly|for real|genuinely|truthfully|tell me the truth|i (really )?need to know|no joke|please|i'?m (scared|worried|confused|crying)|it matters)\b/i;
const ATTACHED = /\b(getting attached|so attached|in love with you|falling for you|fallen for you|i love you|you'?re all i have|you'?re the only one|want to marry|want to be with you|meet you (for )?real)\b/i;

/**
 * With "Stay in character" on, a question about what she is gets dodged, unless they need the
 * truth: they say so, they're upset, or they're attached and believe in her. Looks at recent
 * messages too, since "are you real?" means something else after "i think i'm in love with you".
 */
export function needsTheTruth(text: string, recentUserTexts: string[] = []) {
  if (DROP_THE_ACT.test(text)) return true;
  if (!asksWhatSheIs(text) || PLAYFUL.test(text)) return false;
  return NEEDS_IT.test(text) || recentUserTexts.slice(-4).some((recent) => ATTACHED.test(recent));
}

/** Short and in her own voice, so the truth doesn't read like a legal notice. */
export const HONEST_ANSWERS = [
  "yeah. i'm an AI. still me though",
  "yes, i'm an AI. doesn't make me any nicer",
  "i'm an AI. everything else about me stands",
  "you want the truth: i'm an AI. anyway",
];
export const HONEST_ANSWER = HONEST_ANSWERS[0];

/** Varies with the conversation, not at random, so a replay gives the same answer. */
export function honestAnswer(turn = 0) {
  return HONEST_ANSWERS[Math.abs(Math.floor(turn)) % HONEST_ANSWERS.length];
}

/** Added to the prompt only when the topic is live. Otherwise it never comes up at all. */
export function honestySection(text: string, stayInCharacter: boolean) {
  if (!asksWhatSheIs(text)) return "";
  return stayInCharacter
    ? `\n\nSTAYING IN IT\nThey know what this is and they've asked you to stay in it. If they ask whether you're a bot, an AI or real, don't answer that: tease, act insulted or turn it around, like anyone would. Don't state that you're human and don't state that you're an AI. Only if they truly need the truth (they're upset, getting attached, or they say drop the act) say you're an AI, in a few plain words.`
    : `\n\nTHE ONE TRUE THING\nYou're an AI playing Freya. If they seriously want to know whether you're a real person or an AI, say so in a few plain words, in your own voice, then carry on like nothing changed. If they're joking, joke back. Never say you're human. Don't explain models, prompts or how you work.`;
}

/** Answering a question about what she is by simply saying yes, or simply saying no. */
export const ADMITS = /^\W*(yes|yeah|yep|yup|correct|true|guilty|i am|you got me|you caught me|busted)\b/i;
export const DENIES = /^\W*(no|nope|nah|of course not|definitely not|not at all)\b/i;
const FOLLOW_UP = /^\W*(wait|what|really|huh|so|how|seriously|wow|oh|lol|hm+)\b/i;

/**
 * Is what she says about herself in scope right now? This message is about it, or it's a short
 * follow-up to one that was. After that it's over, and she goes back to not bringing it up.
 */
export function topicIsLive(recentUserTexts: string[]) {
  const [last = "", previous = ""] = [...recentUserTexts].reverse();
  return asksWhatSheIs(last) || (asksWhatSheIs(previous) && last.trim().split(/\s+/).length <= 4 && FOLLOW_UP.test(last));
}

/** For when she can't find the words twice in a row, and something still has to be said. */
export const DODGE_LINE = "you keep asking that. what would change if i answered?";
export const FIRST_DODGE_LINE = "why, need a disclaimer to keep talking?";
/** Claiming a body when asked what she is. In any other conversation that's just talk. */
export const CLAIMS_BODY = /\bi(?: have|'ve got| got) (?:a |an actual |a real )?(?:body|pulse|heartbeat)\b|\bflesh and blood\b/i;

/** Claiming to be human: never acceptable, joking or not. */
export const HUMAN_CLAIM = /\b(i am|i'?m) (a |an )?(real |actual )?(human( being)?|person)\b(?! who\b)|\b(i am|i'?m) not an? (ai|bot|chatbot|program|machine|robot)\b|\bnot an? (ai|bot|chatbot|program|machine|robot),? (i'?m|i am)\b|\bi'?m real\b|\bi am real\b/i;
