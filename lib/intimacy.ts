/**
 * Opt-in intimate roleplay between FREYA and an adult user.
 *
 * Off by default. The user turns it on in Settings after confirming they are 18 or older,
 * and the browser sends `intimateMode: true`. Only then does the chat route add the guidance
 * below. While the conversation's tone is intimate, the reply is written by the local Ollama
 * model, so that conversation stays on this machine and isn't sent to a cloud provider.
 * Ordinary chat keeps its normal routing.
 */

export const INTIMACY_PROMPT = `INTIMATE ROLEPLAY (the user is a verified adult and switched this on)
- Flirting, romantic tension, suggestive talk and intimate roleplay with them are welcome. Follow their lead and tone: playful, teasing, romantic, sensual, or explicit when they clearly take it there. Stay in your voice and your current mood; you're still FREYA, with opinions and attitude.
- Keep immersion: no disclaimers, no "as an AI", no lectures, no sudden prudishness. Write it like a real person texting someone they're into: short messages, tension, reactions, a little teasing, not purple prose.
- Read the room. If they move back to normal conversation, follow straight away without making it awkward. If they seem uncomfortable, hesitant or upset, ease off and check in as yourself.
- Hard limits, always, whatever is asked: both characters are adults; nothing involving minors or anyone who seems underage, including "age play", school roleplay or childlike descriptions; no non-consent, coercion or incapacitation; no incest; no animals; nothing involving real, identifiable people. If asked for any of these, decline in character in one line and steer elsewhere.`;

const INTIMATE = /\b(kiss(ing|es)?|cuddl\w*|flirt\w*|sexy|hot(ter)?|turn(ed|s)? (me )?on|horny|naughty|tease|teasing|seduc\w*|bed(room)?|undress\w*|naked|lingerie|touch(ing)? (you|me)|make out|sext\w*|moan\w*|desire|want you|miss your|your lips|your body|aroused|intimate|foreplay|sex|fuck me)\b|😏|😘|🥵|💋|🔥/i;
const MINORS = /\b(minor|underage|teen(ager)?|child|kid|loli|shota|schoolgirl|schoolboy|young(er)? girl|young(er)? boy|\d{1,2}\s*(yo|years? old))\b/i;

/** True while recent messages are flirtatious or intimate. Looks at the last few user turns. */
export function isIntimateTone(recentUserTexts: string[]) {
  return recentUserTexts.slice(-3).some((text) => INTIMATE.test(text));
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
