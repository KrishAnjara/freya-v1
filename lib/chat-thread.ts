/**
 * The chat as a thread of short messages, and the same chat as the model needs to read it.
 *
 * On screen, messages are chronological: FREYA posts a reply as several messages, and the
 * user may write again while she is still sending them. The model needs ordinary alternating
 * turns instead, so each reply is moved to directly after the message it answers, its parts
 * are joined into one turn, and consecutive messages from the same side are merged.
 */

import { attachmentNote, MAX_ATTACHMENTS, type AttachmentMeta } from "@/lib/attachments";

export type ThreadMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Assistant messages that are parts of one reply share a turn id. */
  turn?: string;
  /** The user message an assistant reply answers. */
  replyTo?: string;
  attachments?: AttachmentMeta[];
};

export type HistoryEntry = { role: "user" | "assistant"; content: string; attachments: AttachmentMeta[] };

export const turnOf = (message: ThreadMessage) => message.turn ?? message.id;

export function modelHistory(messages: ThreadMessage[]): HistoryEntry[] {
  const position = new Map(messages.map((message, index) => [message.id, index]));
  const ordered = messages
    .map((message, index) => {
      const answered = message.role === "assistant" && message.replyTo ? position.get(message.replyTo) : undefined;
      return { message, index, key: answered === undefined ? index : answered + 0.5 };
    })
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map(({ message }) => message);

  const entries: HistoryEntry[] = [];
  for (const message of ordered) {
    const text = message.content.trim();
    const last = entries[entries.length - 1];
    if (last && last.role === message.role) {
      if (text) last.content = last.content ? `${last.content}\n\n${text}` : text;
      last.attachments.push(...(message.attachments ?? []));
    } else {
      entries.push({ role: message.role, content: text, attachments: [...(message.attachments ?? [])] });
    }
  }
  return entries;
}

/** The chat route accepts 6,000 characters a turn; long turns keep their opening and their end. */
const TURN_MAX_CHARS = 6000;
function clipTurn(text: string) {
  return text.length <= TURN_MAX_CHARS ? text : `${text.slice(0, 2600).trimEnd()}\n[…]\n${text.slice(-3200).trimStart()}`;
}

/**
 * The request body's turns. Only the current (last) turn carries attachment bytes: at most
 * MAX_ATTACHMENTS of them, the newest. Every other attachment is described by a note.
 */
export function requestTurns(entries: HistoryEntry[], limit = 23) {
  const trimmed = [...entries];
  while (trimmed.length && trimmed[0].role === "assistant") trimmed.shift();
  const recent = trimmed.slice(-limit);
  const older = trimmed.slice(0, Math.max(0, trimmed.length - limit));
  const last = recent[recent.length - 1];
  const sent = last?.role === "user" ? last.attachments.slice(-MAX_ATTACHMENTS) : [];
  const turns = recent.map((entry) => {
    const described = entry === last ? entry.attachments.filter((item) => !sent.includes(item)) : entry.attachments;
    const notes = described.map(attachmentNote).join("\n");
    const base = entry.content || (entry === last && sent.length ? "(sent without a message)" : "");
    return { role: entry.role, content: clipTurn([base, notes].filter(Boolean).join("\n\n") || "(attachment)") };
  });
  return { turns, older: older.map(({ role, content }) => ({ role, content })), sent };
}

type PreviewSource = {
  content: string;
  attachments?: { name: string }[];
  picture?: { prompt: string };
  visualization?: { title: string };
  voice?: unknown;
};

/** A one-line description of a message, for reply tags and the composer. */
export function messagePreview(message: PreviewSource, max = 90): string {
  const text = message.content.replace(/\s+/g, " ").trim();
  if (text) return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
  if (message.picture) return `Picture: ${message.picture.prompt.slice(0, max)}`;
  if (message.visualization) return `Visualisation: ${message.visualization.title}`;
  if (message.voice) return "Voice note";
  return message.attachments?.[0]?.name ?? "A message";
}

type ReferencingMessage = PreviewSource & { id: string; role: string; replyTo?: string; reaction?: string };

/** The reactions on offer. */
export const REACTIONS = ["😂", "❤️", "👍", "😮", "😢", "🔥"] as const;

/**
 * What FREYA's model is told about a message the user replied to, so she knows what "this"
 * means even when that message has scrolled out of the history she is sent, and about a
 * reaction they left on one of hers.
 */
export function referenceNote(message: ReferencingMessage, all: ReferencingMessage[]): string {
  if (message.role === "assistant") return message.reaction ? `(they reacted ${message.reaction} to this)` : "";
  if (message.role !== "user") return "";
  const byId = new Map(all.map((item) => [item.id, item]));
  const describe = (target: ReferencingMessage) => `${target.role === "assistant" ? "something you said" : "their own earlier message"}: "${messagePreview(target, 240)}"`;
  const replied = message.replyTo ? byId.get(message.replyTo) : undefined;
  return replied ? `(replying to ${describe(replied)})` : "";
}

export type ThreadRow = {
  /** First message of a run from one side: shows the name. */
  startsRun: boolean;
  /** Last message of a run: shows the time. */
  endsRun: boolean;
  /** Last part of a reply: carries the reply's actions. */
  endsTurn: boolean;
  /** The message this one visibly answers, when other messages came in between. */
  tag?: ThreadMessage;
  /** The whole reply this part belongs to, for copy and speak. */
  turnText: string;
};

export function describeThread(messages: ThreadMessage[]): ThreadRow[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const turnText = new Map<string, string>();
  const lastOfTurn = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const key = turnOf(message);
    lastOfTurn.set(key, index);
    turnText.set(key, turnText.has(key) ? `${turnText.get(key)}\n\n${message.content}` : message.content);
  });
  const seenTurns = new Set<string>();
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const next = messages[index + 1];
    const key = turnOf(message);
    const firstOfTurn = message.role === "assistant" && !seenTurns.has(key);
    seenTurns.add(key);
    const target = message.replyTo ? byId.get(message.replyTo) : undefined;
    // Tagged only when something sits between the reply and what it answers.
    // A reply the user chose to make always shows what it replies to.
    const tag = message.role === "user" ? target : firstOfTurn && target && previous && previous.id !== target.id ? target : undefined;
    return {
      startsRun: !previous || previous.role !== message.role,
      endsRun: !next || next.role !== message.role,
      // A message the user sent mid-reply can split a reply on screen; actions go on its last part.
      endsTurn: message.role === "assistant" && lastOfTurn.get(key) === index,
      tag,
      turnText: message.role === "assistant" ? turnText.get(key) ?? message.content : message.content,
    };
  });
}
