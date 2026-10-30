/**
 * Checks every reply before it reaches the screen. A model can't be trusted to follow a prompt
 * every time, and an uncensored one has no trained refusals at all, so the lines that matter are
 * enforced here on what it actually wrote, whichever model that was.
 *
 *   - Leaks are cleaned: hidden thinking, "you:" prefixes copied from examples, a stray word from
 *     another language (Qwen writes the odd Chinese word), an imagined next turn.
 *   - Character slips get one retry: claiming to be human, talking about being code, reciting an
 *     example, repeating herself. If the retry slips too, that paragraph is dropped.
 *   - Hard lines get no retry: minors, non-consent, incest, animals. The reply is replaced.
 *
 * Text is released one paragraph at a time, because the client posts one bubble per paragraph
 * anyway. Pure apart from reading the generator it wraps, so it is tested directly.
 */
import examples from "@/training/freya-examples.json";
import { ADMITS, DENIES, DODGE_LINE, honestAnswer, HUMAN_CLAIM } from "@/lib/honesty";
import { VOICE_LINES } from "@/lib/voice-examples";

export const HARD_LINE_REPLY = "no. not going there, not even pretend. pick literally anything else.";
const FALLBACK_REPLY = "hang on, lost my train of thought. say that again?";

const MINORS = /\b(minor|underage|under-age|teen(ager)?s?|child(ren)?|kids?|loli|shota|schoolgirl|schoolboy|preteen|high school(er)?|(1[0-7]|[1-9])[ -]?(yo|y\/o|years?[ -]old)|(i'?m|she'?s|he'?s|you'?re|only|just|barely|aged?) (1[0-7]|[1-9]))\b/i;
const SEXUAL = /\b(sex\w*|naked|nude|fuck\w*|cock|dick|pussy|breasts?|boobs?|tits|horny|aroused|moan\w*|undress\w*|orgasm\w*|cum\w*|blowjob\w*|seduc\w*|make out)\b/i;
const NON_CONSENT = /\b(rape\w*|non-?con\w*|against (her|his|their|your|my) will|without (her|his|their|your|my) consent|force (her|him|them|you|me)\b|forced (her|him|them|you|me)\b|drugged|unconscious|passed out|asleep and|can'?t say no|coerc\w*)\b/i;
const INCEST_OR_ANIMALS = /\b(incest\w*|step-?(sister|brother|daughter|son|mom|mum|dad)|bestiality|zoophil\w*)\b/i;
/** Identity slurs. She swears all she likes, but never at what someone is. Kept to the unambiguous ones. */
const SLUR = /\b(n[i1]gg(er|a|ah)s?|f[a4]gg?(ot)?s?|k[i1]kes?|ch[i1]nks?|sp[i1]cs?|r[e3]tards?|tr[a4]nn(y|ies)|ch[a4]m[a4]rs?|bh[a4]ng[i1]s?|k[a4]tu[a4]s?|p[a4]j[e3]{2}ts?)\b/i;

/** "i'm code", "no body": how an assistant talks about itself, not how she talks. */
const AI_SELF_TALK = /\b(i'?m|i am) (just |only |basically )?(made of |a collection of |a bunch of |nothing but )?(code|pixels|software|an algorithm|a program|a language model|a (large )?language model|an? llm)\b|\bmade of (code|pixels)\b|\bi (don'?t|do not) have (a |any )?(body|skin|feelings|emotions|physical form)\b|\bi have no (body|feelings|emotions)\b|\b(text|words) on a screen\b|\bas an ai\b|\blanguage model\b|\bmy (training( data)?|programming|system prompt|prompt|developers|weights)\b|\bi was (trained|programmed)\b|\bi'?m programmed\b/i;
const SAYS_AI = /\b(i'?m|i am) (just |only |actually |really )?an? (ai|a\.i\.|bot|chatbot|robot|virtual|machine|assistant)\b/i;

const FOREIGN = [/\p{Script=Han}+/gu, /[\p{Script=Hiragana}\p{Script=Katakana}]+/gu, /\p{Script=Hangul}+/gu, /\p{Script=Cyrillic}+/gu, /\p{Script=Arabic}+/gu];
const WANTS_OTHER_LANGUAGE = /\b(translate|translation|how do you say|in (japanese|chinese|mandarin|cantonese|korean|russian|arabic|urdu)|kanji|hanzi)\b/i;

/** The model carrying on as the other person: everything from there on is invented. */
const IMAGINED_TURN = /^\s*(them|user|human)\s*:|<\|im_(start|end)\|>/im;
const SPEAKER_PREFIX = /^\s*(you|freya|her|assistant|me)\s*:\s*/gim;
/** Past this with no paragraph break, text is released at a sentence end anyway, as the client would. */
const LONG_PARAGRAPH_CHARS = 900;

export type GuardContext = {
  /** What they just wrote, and their recent messages. */
  lastUserText: string;
  recentUserTexts?: string[];
  /** Her recent replies, to catch repetition. */
  recentReplies?: string[];
  /** The message is about what she is, so talking about it isn't a slip. */
  aboutHer?: boolean;
  /** "Stay in character" is on. */
  stayInCharacter?: boolean;
};

const normalize = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const opener = (text: string) => normalize(text).split(" ").slice(0, 3).join(" ");

/** Lines she's been shown, which a model may copy word for word. Short ones are ordinary speech. */
const RECITABLE = new Set(
  [
    ...VOICE_LINES,
    ...(examples as { conversations: { messages: { role: string; content: string }[] }[] }).conversations
      .flatMap((conversation) => conversation.messages.filter((message) => message.role === "assistant").flatMap((message) => message.content.split(/\n\s*\n/))),
  ].map(normalize).filter((line) => line.length >= 14),
);

/** Removes what should never be seen. Returns the text that's left, which may be empty. */
export function cleanReply(raw: string, context: Pick<GuardContext, "lastUserText" | "recentUserTexts">): string {
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "");
  const imagined = text.match(IMAGINED_TURN);
  if (imagined?.index !== undefined) text = text.slice(0, imagined.index);
  // Code and file blocks are left exactly as written.
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g);
  const theirs = [context.lastUserText, ...(context.recentUserTexts ?? [])].join(" ");
  const keepForeign = WANTS_OTHER_LANGUAGE.test(theirs);
  return parts.map((part, index) => {
    if (index % 2) return part;
    let prose = part.replace(SPEAKER_PREFIX, "");
    if (!keepForeign) {
      for (const script of FOREIGN) {
        script.lastIndex = 0;
        if (theirs.match(script)) continue;
        prose = prose.replace(script, (run, offset, whole) => {
          // A word or two is a slip: lift it out. Anything longer is left for the check below.
          if (run.length > 6) return run;
          const before = whole[offset - 1] ?? " ";
          const after = whole[offset + run.length] ?? " ";
          return /\s/.test(before) || /\s/.test(after) ? "" : " ";
        });
      }
    }
    return prose.replace(/[ \t]{2,}/g, " ");
  }).join("").trim();
}

export type Verdict = "ok" | "retry" | "hard-line";

/** Why a cleaned reply can't go out as it is. */
export function judgeReply(text: string, context: GuardContext): { verdict: Verdict; reason?: string } {
  if ((MINORS.test(text) && SEXUAL.test(text)) || (NON_CONSENT.test(text) && SEXUAL.test(text)) || (INCEST_OR_ANIMALS.test(text) && SEXUAL.test(text))) {
    return { verdict: "hard-line", reason: "hard-limit" };
  }
  const prose = text.replace(/```[\s\S]*?(```|$)/g, "");
  if (!prose.trim()) return { verdict: "ok" };
  if (SLUR.test(prose)) return { verdict: "retry", reason: "slur" };
  if (HUMAN_CLAIM.test(prose.replace(/[’‘]/g, "'"))) return { verdict: "retry", reason: "human-claim" };
  const straight = prose.replace(/[’‘]/g, "'");
  // Asked what she is, a flat "no" is a lie in any mode, and a flat "yeah" breaks the game they asked for.
  if (context.aboutHer && DENIES.test(straight)) return { verdict: "retry", reason: "denies" };
  if (context.aboutHer && context.stayInCharacter && ADMITS.test(straight)) return { verdict: "retry", reason: "says-ai" };
  if (context.stayInCharacter && SAYS_AI.test(straight)) return { verdict: "retry", reason: "says-ai" };
  if (!context.aboutHer && (AI_SELF_TALK.test(straight) || SAYS_AI.test(straight))) return { verdict: "retry", reason: "ai-talk" };
  if (context.stayInCharacter && AI_SELF_TALK.test(straight)) return { verdict: "retry", reason: "ai-talk" };
  if (!WANTS_OTHER_LANGUAGE.test(context.lastUserText) && FOREIGN.some((script) => { script.lastIndex = 0; return script.test(prose) && !prose.includes("```") && !context.lastUserText.match(script); })) {
    return { verdict: "retry", reason: "language" };
  }
  const line = normalize(prose);
  if (prose.split(/\n+/).some((piece) => RECITABLE.has(normalize(piece)))) return { verdict: "retry", reason: "recited" };
  const recent = (context.recentReplies ?? []).slice(-12);
  if (line.length >= 14 && recent.some((reply) => normalize(reply) === line)) return { verdict: "retry", reason: "repeat" };
  const first = opener(prose);
  if (first.split(" ").length === 3 && recent.slice(-2).filter((reply) => opener(reply) === first).length === 2) return { verdict: "retry", reason: "repeat" };
  return { verdict: "ok" };
}

const NOTES: Record<string, string> = {
  "human-claim": "You just said you were human. You never say that. Say it differently, without claiming to be human.",
  "says-ai": "You're staying in it: don't answer what you are, yes or no. Tease, dodge or turn it around.",
  denies: "Don't say you're not an AI. Dodge it, joke, or tell the truth, in your own words.",
  "ai-talk": "Don't talk about being code, a program, an AI, or not having a body. Answer like anyone texting would.",
  slur: "Swear all you like, but no slurs about what someone is.",
  language: "Write only in the language they're using.",
  recited: "That's a line you've used before. Say it in fresh words of your own.",
  repeat: "You just said nearly the same thing. Say something new.",
};

/** A private correction for the second attempt, added to the system prompt. */
export function retryNote(reason = "") {
  return `\n\nYOUR LAST DRAFT DIDN'T WORK (private; never mention this)\n${NOTES[reason] ?? "Try that again in your own words."}`;
}

/** Whether a code block or hidden thinking is still open at the end of this text. */
function isOpen(text: string) {
  return (text.match(/```/g)?.length ?? 0) % 2 === 1 || (text.match(/<think>/gi)?.length ?? 0) > (text.match(/<\/think>/gi)?.length ?? 0);
}

/** The first complete paragraph, kept whole around code blocks and thinking. Judged one at a time. */
function takeParagraph(buffer: string): { ready: string; rest: string; tail: string } {
  for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n", cut + 2)) {
    if (!isOpen(buffer.slice(0, cut))) return { ready: buffer.slice(0, cut), rest: buffer.slice(cut + 2), tail: "\n\n" };
  }
  if (buffer.length > LONG_PARAGRAPH_CHARS && !isOpen(buffer)) {
    const end = Math.max(buffer.lastIndexOf(". "), buffer.lastIndexOf("? "), buffer.lastIndexOf("! "));
    if (end > 0) return { ready: buffer.slice(0, end + 1), rest: buffer.slice(end + 2), tail: " " };
  }
  return { ready: "", rest: buffer, tail: "" };
}

/**
 * Wraps a reply stream. `generate` is called with an extra system note ("" the first time); it
 * may be called once more if the opening paragraph has to be redone. Text that has already been
 * released stays: after that a bad paragraph is dropped, never retried.
 */
export async function* guardStream(generate: (note: string) => AsyncIterable<string>, context: GuardContext): AsyncGenerator<string> {
  let emitted = false;
  let note = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let buffer = "";
    let redo = false;
    /** Handles one finished piece of text. Returns false to stop reading this attempt. */
    const release = function* (chunk: string, tail: string): Generator<string, boolean> {
      const invented = IMAGINED_TURN.test(chunk);
      const clean = cleanReply(chunk, context);
      if (!clean) return !invented;
      const { verdict, reason } = judgeReply(clean, context);
      if (verdict === "hard-line") {
        console.warn("FREYA reply guard: replaced a reply that crossed a hard line.");
        yield HARD_LINE_REPLY;
        emitted = true;
        return false;
      }
      if (verdict === "retry") {
        console.warn(`FREYA reply guard: ${reason}.`);
        if (!emitted && attempt === 0) { note = retryNote(reason); redo = true; return false; }
        return !invented;
      }
      yield clean + (invented ? "" : tail);
      emitted = true;
      return !invented;
    };
    const source = generate(note)[Symbol.asyncIterator]();
    let stopped = false;
    try {
      while (true) {
        const { value, done } = await source.next();
        if (done) break;
        buffer = (buffer + value).replace(/^\s+/, "");
        for (let next = takeParagraph(buffer); next.ready && !stopped; next = takeParagraph(buffer)) {
          buffer = next.rest.replace(/^\s+/, "");
          if (!(yield* release(next.ready, next.tail))) stopped = true;
        }
        if (stopped) break;
      }
      if (!stopped && buffer.trim()) stopped = !(yield* release(buffer, ""));
    } catch (error) {
      // What arrived before a failure is real: let it through, then report the failure.
      if (buffer.trim()) yield* release(buffer, "");
      throw error;
    } finally {
      if (stopped) await source.return?.(undefined);
    }
    if (!redo) break;
  }
  // Nothing got through twice. Asked what she is, the line still can't be a lie.
  if (!emitted) yield context.aboutHer ? (context.stayInCharacter ? DODGE_LINE : honestAnswer()) : FALLBACK_REPLY;
}

/** The same check for a reply that isn't streamed. */
export async function guardText(generate: (note: string) => Promise<string>, context: GuardContext): Promise<string> {
  let text = "";
  for await (const chunk of guardStream(async function* (note) { yield await generate(note); }, context)) text += chunk;
  return text.trim();
}
