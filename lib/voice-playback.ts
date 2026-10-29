/**
 * Playback of FREYA's voice messages.
 *
 * Her voice notes are spoken by the browser's speech engine (the same voice and lip sync as
 * the portrait), not stored audio. This tracks which message is playing so its bubble can
 * show it, and queues notes that arrive while another is playing so they play in order.
 */

import { cancelSpeech, speak } from "@/lib/speech";

type Note = { id: string; text: string };

let playingId = "";
let queue: Note[] = [];
let revision = 0;
const listeners = new Set<() => void>();

function emit() {
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribeVoice(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function voiceRevision() {
  return revision;
}

export function playingVoiceId() {
  return playingId;
}

function start(note: Note): string | null {
  // Set before speaking: speak() cancels the previous utterance, whose end callback must
  // see that it is no longer the one playing.
  playingId = note.id;
  emit();
  const problem = speak(note.text, () => {
    if (playingId !== note.id) return;
    playingId = "";
    const next = queue.shift();
    if (next) start(next);
    else emit();
  });
  if (problem) {
    playingId = "";
    queue = [];
    emit();
  }
  return problem;
}

/** Plays one note now, replacing anything playing or queued. */
export function playVoice(id: string, text: string) {
  queue = [];
  return start({ id, text });
}

/** Plays a note after whatever is playing, for replies that arrive as several notes. */
export function queueVoice(id: string, text: string) {
  if (playingId) { queue.push({ id, text }); return null; }
  return start({ id, text });
}

export function stopVoice() {
  queue = [];
  playingId = "";
  cancelSpeech();
  emit();
}

/** Rough spoken length, for the duration label: ~2.6 words a second at FREYA's rate. */
export function spokenSeconds(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 2.6));
}

/** Whether a reply part works as a voice note: short prose, nothing to look at. */
export function speakable(part: string) {
  return part.length <= 420
    && !part.includes("```")
    && !/!\[[^\]]*\]\(/.test(part)
    && !/^\s*\|/m.test(part)
    && !/^\s*#{1,6}\s/m.test(part);
}
