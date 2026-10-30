/**
 * Splits a streaming reply into chat-sized messages.
 *
 * FREYA texts rather than writes essays: each finished block of the reply (a paragraph, a
 * list, a code or file block) is posted as its own message as soon as it is complete, instead
 * of one bubble growing for a minute. Pure and framework-free so it can be tested directly.
 *
 * Rules:
 * - A block ends at a blank line, or where a fenced block opens or closes.
 * - Fenced blocks are never cut; markdown inside them is not split.
 * - A heading, or a line ending in ":", stays with the block it introduces.
 * - Consecutive list blocks stay together.
 * - Prose longer than LONG_PROSE_CHARS is cut at a sentence end so no bubble is a wall.
 */

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const LONG_PROSE_CHARS = 900;
const MIN_SPLIT_CHARS = 240;

type Block = { text: string; fence: boolean };

function closesFence(line: string, marker: string) {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && trimmed[0] === marker[0] && /^(`+|~+)$/.test(trimmed);
}

/** Complete blocks, plus the unfinished tail that may still grow. */
function scanBlocks(buffer: string, final: boolean) {
  const lines = buffer.split("\n");
  // The last line is unterminated and may still be growing, unless the stream has ended.
  const partial = final ? "" : lines.pop() ?? "";
  const blocks: Block[] = [];
  let current: string[] = [];
  let marker = "";
  const flushProse = () => {
    if (current.length) blocks.push({ text: current.join("\n").trim(), fence: false });
    current = [];
  };
  for (const line of lines) {
    if (marker) {
      current.push(line);
      if (current.length > 1 && closesFence(line, marker)) {
        blocks.push({ text: current.join("\n"), fence: true });
        current = [];
        marker = "";
      }
      continue;
    }
    const open = line.match(FENCE_OPEN);
    if (open) {
      flushProse();
      marker = open[1];
      current.push(line);
      continue;
    }
    if (!line.trim()) { flushProse(); continue; }
    current.push(line);
  }
  if (final) {
    // An unclosed fence at the very end is closed so it still renders as code.
    if (marker && current.length) blocks.push({ text: `${current.join("\n")}\n${marker}`, fence: true });
    else flushProse();
    return { blocks: blocks.filter((block) => block.text), tail: "", tailInFence: false };
  }
  const tail = current.length ? `${current.join("\n")}\n${partial}` : partial;
  return { blocks: blocks.filter((block) => block.text), tail, tailInFence: Boolean(marker) };
}

const isHeading = (text: string) => /^#{1,6}\s/.test(text) && !text.includes("\n");
const isList = (text: string) => /^\s*([-*+]|\d+[.)])\s/.test(text);
const isTable = (text: string) => /^\s*\|/.test(text);
/** A block that introduces whatever follows it. */
const leadsIn = (block: Block) => !block.fence && (isHeading(block.text) || /[:：]\s*$/.test(block.text));

function joins(previous: Block, next: Block) {
  if (leadsIn(previous)) return true;
  return !previous.fence && !next.fence && isList(previous.text) && isList(next.text);
}

/** Whether the block after `last` could still be pulled into its group. */
function mayJoinNext(last: Block) {
  return leadsIn(last) || (!last.fence && isList(last.text));
}

/** Cuts long prose at sentence ends; lists, tables and code are left whole. */
export function splitLongProse(text: string, limit = LONG_PROSE_CHARS): string[] {
  if (text.length <= limit || text.includes("```") || isList(text) || isTable(text)) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = sentenceCut(rest, limit);
    if (cut < 0) break;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Index just after the last sentence end inside [MIN_SPLIT_CHARS, limit], or -1. */
function sentenceCut(text: string, limit: number) {
  const pattern = /[.!?。！？।…]["'”’)\]]*\s+/g;
  let cut = -1;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const end = match.index + match[0].length;
    if (end > limit) break;
    if (end >= MIN_SPLIT_CHARS) cut = end;
  }
  return cut;
}

/**
 * Takes every finished message out of `buffer`.
 *
 * Returns the messages ready to post and the remainder to keep buffering. Call it after each
 * streamed chunk with `final = false`, and once more with `final = true` when the stream ends
 * to flush the rest. The function is pure: feeding `rest` plus new text back in is safe.
 */
export function takeCompleteParts(buffer: string, final = false): { parts: string[]; rest: string } {
  const { blocks, tail, tailInFence } = scanBlocks(buffer, final);
  const groups: Block[][] = [];
  for (const block of blocks) {
    const group = groups[groups.length - 1];
    if (group && joins(group[group.length - 1], block)) group.push(block);
    else groups.push([block]);
  }

  // The last group waits if the next block might still belong to it.
  let held: Block[] | undefined;
  if (!final && groups.length && mayJoinNext(groups[groups.length - 1].at(-1)!)) held = groups.pop();

  const parts: string[] = [];
  for (const group of groups) {
    const text = group.map((block) => block.text).join("\n\n");
    if (group.length === 1 && !group[0].fence) parts.push(...splitLongProse(text));
    else parts.push(text);
  }

  let rest = tail;
  // A paragraph that is still streaming but already long is cut at its last full sentence.
  if (!held && !tailInFence && rest.length > LONG_PROSE_CHARS && !isList(rest) && !isTable(rest)) {
    const cut = sentenceCut(rest, LONG_PROSE_CHARS);
    if (cut > 0) {
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
  }
  if (held) rest = `${held.map((block) => block.text).join("\n\n")}\n\n${rest}`;
  return { parts: parts.filter(Boolean), rest };
}

/**
 * How long FREYA "types" a message before it is posted, in ms. Streams usually outrun
 * reading speed, and a burst of six bubbles at once reads as a dump, not a conversation.
 */
export function typingDelay(part: string) {
  return Math.min(1600, 320 + part.length * 3);
}

/**
 * How long she takes to pick up when she's in the middle of something (lib/her-day): a person at
 * work doesn't answer in three seconds, but nobody should wait long enough to think it broke.
 */
export function busyDelay(random: () => number = Math.random) {
  return 8000 + random() * 37_000;
}

/** Consecutive bubbles never land closer than this: a person sends one text, then the next. */
export const MIN_BUBBLE_GAP_MS = 1000;

/** Delay before posting a bubble; a follow-up bubble waits at least MIN_BUBBLE_GAP_MS. */
export function bubbleDelay(part: string, followUp: boolean) {
  return followUp ? Math.max(MIN_BUBBLE_GAP_MS, typingDelay(part)) : typingDelay(part);
}

/**
 * Casual texting rhythm: a paragraph is sometimes sent whole and sometimes broken after a
 * sentence, at random, the way people fire off a thought in two or three messages. Code,
 * lists, tables and quotes are never broken. `random` is injectable for tests.
 */
export function chopCasually(part: string, random: () => number = Math.random): string[] {
  if (part.length < 70 || part.includes("```") || /^\s*([-*+]|\d+[.)]|\||>|#)/m.test(part)) return [part];
  const sentences = part.match(/[^.!?。！？…]+(?:[.!?。！？…]+["'”’)\]]*|$)\s*/g)?.map((piece) => piece.trim()).filter(Boolean) ?? [part];
  if (sentences.length < 2) return [part];
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    current = current ? `${current} ${sentence}` : sentence;
    // Break after roughly a third of sentences, never leaving a scrap shorter than ~25 chars.
    if (current.length >= 25 && random() < 0.38) {
      pieces.push(current);
      current = "";
    }
  }
  if (current) {
    if (current.length < 25 && pieces.length) pieces[pieces.length - 1] += ` ${current}`;
    else pieces.push(current);
  }
  return pieces;
}

/**
 * Requests for a composed piece (an essay, a letter, a story) get one document-like message,
 * typed out, instead of a run of chat bubbles. Only its short lead-in and sign-off are split
 * off as ordinary messages.
 */
export function wantsLongForm(request: string) {
  const composed = /\b(essay|letter|story|poem|article|report|speech|script|cover letter|blog( post)?|biography|summary|summari[sz]e|lyrics|email|e-mail|proposal|statement|review|chapter|monologue|eulogy|toast|guide|tutorial|write-?up|overview)\b/i.test(request)
    && /\b(write|draft|compose|make|create|give me|craft|pen|need)\b/i.test(request);
  // Asking for depth is asking for a document, whatever the subject.
  const depth = /\b(explain|describe|teach|break (it )?down|walk me through|tell me (all|everything))\b.*\b(in (great |full )?detail|in depth|in-depth|thoroughly|step by step|properly|everything)\b|\b(detailed|in-depth|comprehensive|thorough) (explanation|guide|overview|breakdown|answer|analysis)\b/i.test(request);
  return composed || depth;
}

/** Past this, an ordinary reply is a document, not a chat. */
const LONG_REPLY_CHARS = 1400;

/**
 * Whether a reply that started as chat should become a document now: it has reached headings
 * or a substantial list, or it has simply run long.
 */
export function becomesLongForm(nextPart: string, sentChars: number) {
  const listItems = nextPart.match(/^\s*([-*+]|\d+[.)])\s/gm)?.length ?? 0;
  const structured = /^\s*(#{1,3}\s|\|.*\|)/m.test(nextPart) || (listItems >= 3 && nextPart.length > 220);
  return structured || sentChars + nextPart.length > LONG_REPLY_CHARS;
}

/** A lead-in or sign-off short enough to sit outside a composed piece. */
export function isAside(block: string) {
  return block.length <= 220 && !/^\s*#/.test(block) && !block.includes("```") && !/\n/.test(block.trim());
}
