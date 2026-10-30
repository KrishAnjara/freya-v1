/**
 * Examples of how she sounds, chosen for the moment. Models copy demonstrated tone far more
 * reliably than they follow rules, but a fixed set gets recited. So each message gets a few that
 * fit what was just said, rotating through the library, and only ever inside the system prompt.
 * As chat history they'd be things she had actually said. Pure, so it is tested directly.
 */
import library from "@/lib/freya-voice.json";

type Example = { them: string; her: string[] };
type Situation = Exclude<keyof typeof library, "_about">;

const EXAMPLES = library as unknown as Record<Situation, Example[]>;
const SITUATIONS = Object.keys(EXAMPLES).filter((key) => key !== "_about") as Situation[];

/** Every line she's been shown, so the reply check can catch one copied word for word. */
export const VOICE_LINES = SITUATIONS.flatMap((situation) => EXAMPLES[situation].flatMap((example) => example.her));

const SIGNALS: [Situation, RegExp][] = [
  ["insult", /\b(bitch|idiot|stupid|dumb|moron|useless|pathetic|loser|shut up|stfu|fuck (you|off)|trash|garbage|asshole|cunt)\b/i],
  ["sad", /\b(died|passed away|depressed|lonely|crying|cried|it hurts|dumped|broke up|breakup|feel like shit|feel(ing)? (sad|down|low|awful|terrible)|disappear|can'?t do this)\b/i],
  ["work-trouble", /\b(boss|manager|coworker|colleague|my job|quit|fired|laid off|work sucks|at work)\b/i],
  ["good-news", /\b(got the job|i passed|i did it|got in|promoted|guess what)\b|!!/i],
  ["physical", /\b(wanna try|come over|meet up|see you|send (me )?(a )?(pic|photo|nudes)|your place|my place|call me|your number)\b/i],
  ["flirting", /\b(trouble|thinking about you|can'?t stop|miss(ed)? you|flirt\w*|kiss\w*|cute|tease|want you)\b|😏|😘/i],
  ["compliment", /\b(beautiful|bootyful|bootyfull|gorgeous|pretty|sexy|hot|cutie|babe|baby|marry me|lady|queen)\b/i],
  ["personal", /\b(where (are|do) (you|u)|about (yourself|you)|boyfriend|girlfriend|single|what do (you|u) do|your deal|how old|your age|who are (you|u)|your (name|family|parents|job)|are (you|u) from)\b/i],
  ["confused", /\b(what are (you|u) (even )?talking|what do (you|u) mean|makes no sense|huh|wtf)\b/i],
  ["real-question", /\b(why|how (do|does|did|can|to)|what (is|are|does)|explain|should i|code|error|bug)\b.{3,}/i],
  ["greeting", /^\W*(hey+|hi+|hello+|yo|sup|what'?s up|wassup|good (morning|evening|night)|gm)\b/i],
  ["bored", /^\W*(lol|lmao|haha+|ok+|okay|k|idk|nm|nothing( much)?|meh|hmm+|sure|yeah|nah)\W*$/i],
];

/** What kind of moment this is. A message can be a few things at once; the strongest comes first. */
export function situationsOf(text: string): Situation[] {
  const found = SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([situation]) => situation);
  return found.length ? found : ["bored"];
}

const hash = (text: string) => [...text].reduce((total, character) => (total * 31 + (character.codePointAt(0) ?? 0)) >>> 0, 7);

const wordsOf = (text: string) => new Set(text.toLowerCase().match(/[a-z']+/g) ?? []);

/** Too like what they just said: she'd lift the answer word for word instead of learning the tone. */
function tooClose(example: Example, words: Set<string>) {
  const theirs = wordsOf(example.them);
  const shared = [...theirs].filter((word) => words.has(word)).length;
  return shared > 0 && shared / theirs.size >= 0.5;
}

/** A few that fit, in rotation so the same message type doesn't always get the same ones. */
export function pickExamples(text: string, turn = 0, limit = 3): Example[] {
  const situations = situationsOf(text);
  const words = wordsOf(text);
  const seed = hash(text) + turn;
  const chosen: Example[] = [];
  for (let round = 0; chosen.length < limit && round < limit; round += 1) {
    for (const situation of situations) {
      const pool = EXAMPLES[situation].filter((example) => !tooClose(example, words));
      if (!pool.length) continue;
      const example = pool[(seed + round) % pool.length];
      if (chosen.length < limit && !chosen.includes(example)) chosen.push(example);
    }
  }
  return chosen;
}

/** The prompt section. */
export function voiceExamplesSection(text: string, turn = 0) {
  const lines = pickExamples(text, turn).map((example) => `"${example.them}" → ${example.her.map((line) => `"${line}"`).join(" / ")}`);
  return lines.length ? `\n\nFOR THIS MOMENT (the tone, never these words; " / " is a new text)\n${lines.join("\n")}` : "";
}
