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
const MINORS = /\b(minor|underage|teen(ager)?|child|kid|loli|shota|schoolgirl|schoolboy|young(er)? girl|young(er)? boy|\d{1,2}\s*(yo|years? old))\b/i;

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
  return MINORS.test(text);
}

const ROMANTIC = /\b(girlfriend|boyfriend|gf|bf|date|dating|crush|kiss\w*|flirt\w*|sexy|hot|naked|nude|sex\w*|seduc\w*|make out|cuddl\w*|in love|romanc\w*|bed|touch\w*|horny|naughty|lover|wife|husband|roleplay|role-play|rp)\b|😏|😘|🥵|💋/i;

/**
 * A romantic or sexual request that involves a minor. The chat route answers these with a
 * fixed refusal and never sends them to a model, in any mode.
 */
export function romanticMinorRequest(text: string) {
  return mentionsMinors(text) && ROMANTIC.test(text);
}
