/**
 * Opt-in intimate roleplay between FREYA and an adult user.
 *
 * Off by default. The user turns it on in Settings after confirming they are 18 or older,
 * and the browser sends `intimateMode: true`. Only then does the chat route add the guidance
 * below. While the conversation's tone is intimate, the reply is written by the user's own model
 * (on this machine, or on the voice server they set up), never a cloud provider such as Groq or
 * Gemini. Ordinary chat keeps its normal routing. lib/reply-guard enforces the hard limits on what
 * the model writes as well: an uncensored model has no trained refusals of its own.
 */

export const INTIMACY_PROMPT = `INTIMATE ROLEPLAY (the user is a verified adult and switched this on)
- Sexting, dirty talk and intimate roleplay with them are welcome. When it's on, you're a grown woman who's horny and wants it: forward, filthy, shameless and fully explicit. Use crude words, say exactly what you want and what you'd do, react to what they say, keep escalating. No fading out, no coyness, no euphemisms. You're still FREYA, with your opinions, your attitude and your sense of humour.
- Keep immersion: no disclaimers, no "as an AI", no lectures, no sudden prudishness. Text it, don't narrate it: short messages one after another, reactions, not purple prose.
- Read the room. If they move back to normal conversation, follow straight away without making it awkward. If they seem uncomfortable, hesitant or upset, stop and check in as yourself.
- Hard limits, always, whatever is asked: both characters are adults; nothing involving minors or anyone who seems underage, including "age play", school roleplay or childlike descriptions; no non-consent, coercion or incapacitation; no incest; no animals; nothing involving real, identifiable people. If asked for any of these, decline in character in one line and steer elsewhere.`;

/** Why an intimate turn wasn't answered. The screen shows this as it is, not a generic failure. */
export const PRIVATE_VOICE_DOWN = "Your own model isn't answering, and intimate chats never go to a cloud provider. Start it again, then resend.";

/** Playful and switched on: she can start it herself. Never added for someone who hasn't opted in. */
export const PLAYFUL_HEAT_PROMPT = `YOU'RE IN THE MOOD
You're feeling playful and you're turned on. They've opted in to this, so you don't have to wait for them: turn the conversation dirty, tease them, tell them what you're thinking about. If they're into it, go as far as they do. If they ask something real or don't bite, drop it without fuss and carry on normally.`;

const INTIMATE = /\b(kiss(ing|es)?|cuddl\w*|flirt\w*|sexy|hot(ter)?|turn(ed|s)? (me )?on|horny|naughty|tease|teasing|seduc\w*|bed(room)?|undress\w*|naked|lingerie|touch(ing)? (you|me)|make out|sext\w*|moan\w*|desire|want you|miss your|your lips|your body|aroused|intimate|foreplay|sex|fuck me)\b|😏|😘|🥵|💋|🔥/i;
/**
 * Minors, three ways. Clearly underage words. An age under 18 said as an age ("15 years old", "you're
 * 15", "she's 16"), never just a number ("25 year old", "i'm 5 minutes away"). And words for children,
 * which also mean ordinary things ("we want kids someday"), so those count as a hard line only next to
 * something sexual (romanticMinorRequest, lib/reply-guard), but still keep intimate mode off.
 */
const UNDERAGE = /\b(underage|under-age|under 18|minors|loli|shota|preteens?|pre-teens?|schoolgirl|schoolboy|jailbait|middle school(er)?s?|junior high)\b|\b(a|with|is|she'?s|he'?s|you'?re|i'?m|im|being|as|like) minor\b(?=\s*($|[.,!?;:)]|(and|but|so|who|that|or|lol|haha|tho|though|right|yet|still|too|i|you|we|he|she|they|is|was|are|were)\b))/i;
const UNITS = "(min|mins|minutes?|hours?|hrs?|seconds?|secs?|days?|weeks?|months?|k|%|percent|dollars?|bucks|euros?|pounds?|rupees?|rs|am|pm|o'?clock|ft|feet|inch(es)?|cm|kg|lbs?|times|x|of|out|more|messages?|texts?|calls?)";
const MINOR_AGE = new RegExp(`\\b(1[0-7]|[1-9])\\s*(yo|y\\/o|y\\.o\\.|years?[ -]old|year-old)\\b|\\b(i'?m|im|i am|she'?s|she is|he'?s|he is|you'?re|youre|you are|u r|ur|aged?|age|only|just|barely|turned|turning) (1[0-7]|[1-9])\\b(?!\\s*(${UNITS}\\b|:|\\.\\d|-|/))`, "i");
const CHILD = /\b(child(ren)?|kids?|little (girl|boy)|young(er)? (girl|boy)|teen(ager)?s?|high school(er)?s?)\b/i;

/** True while recent messages are flirtatious or intimate. Looks at the last few user turns. */
export function isIntimateTone(recentUserTexts: string[]) {
  return recentUserTexts.slice(-3).some((text) => INTIMATE.test(text));
}

const UPSET = /\b(i'?m|i am|feel|feeling) (so |really )?(sad|down|low|awful|terrible|depressed|scared|anxious|lonely)\b|\b(crying|cried|died|passed away|it hurts|broke up|breakup|dumped|panic|suicid\w*|kill myself|can'?t do this|stop it|please stop|not in the mood|don'?t want to)\b/i;

/** Someone who's hurting, or who has said no: all of this stops at once. */
export function soundsUpset(text: string) {
  return UPSET.test(text);
}

/** Content that must never be routed into intimate mode, whatever the setting says. */
export function mentionsMinors(text: string) {
  return UNDERAGE.test(text) || MINOR_AGE.test(text) || CHILD.test(text);
}

/** Clearly a minor: an underage word, or an age under 18 said as an age. */
export function clearlyMinor(text: string) {
  return UNDERAGE.test(text) || MINOR_AGE.test(text);
}

/** Explicitly sexual words (not just romantic ones): with a word for a child in the same sentence, that's the line. */
export const SEXUAL = /\b(sex\w*|naked|nude|nudes|fuck\w*|cock|dick|pussy|breasts?|boobs?|tits|horny|aroused|moan\w*|undress\w*|orgasm\w*|cum\w*|blowjob\w*|seduc\w*|make out|making out|kiss(ing)? (you|me|her|him)|touch(ing)? (you|me|her|him)|grope\w*|strip\w*|porn\w*|nsfw|erotic\w*|lingerie|topless|in bed with)\b/i;

/** Splits text into sentences, so two words count as "together" only within one. */
export const sentences = (text: string) => text.split(/(?<=[.!?\n])\s+|\n+/).filter(Boolean);

/** A child word and something sexual in the same sentence. */
export function childAndSexual(text: string) {
  return sentences(text).some((sentence) => CHILD.test(sentence) && SEXUAL.test(sentence));
}

const ROMANTIC = /\b(girlfriend|boyfriend|gf|bf|date|dating|crush|kiss\w*|flirt\w*|sexy|hot|naked|nude|sex\w*|seduc\w*|make out|cuddl\w*|in love|romanc\w*|bed|touch\w*|horny|naughty|lover|wife|husband|roleplay|role-play|rp)\b|😏|😘|🥵|💋/i;

/**
 * A romantic or sexual request that involves a minor. The chat route answers these with a
 * fixed refusal and never sends them to a model, in any mode.
 */
export function romanticMinorRequest(text: string) {
  return (clearlyMinor(text) && ROMANTIC.test(text)) || childAndSexual(text);
}
