/**
 * Speech playback, kept out of the React tree.
 *
 * Playback used to live in an effect inside VoiceControls, which only mounts while the
 * settings dialog is open on its Settings tab. Pressing Speak on a message therefore set
 * state that nothing was listening to, and nothing was ever said. Playback belongs to the
 * app, not to a panel, so it lives here and is called straight from the click handler —
 * which also keeps it inside the user gesture that autoplay policies look for.
 */

import { beginUtterance, stopSpeaking, syncBoundary } from "@/lib/mouth-drive";
import { detectLanguage } from "@/lib/detect-language";
import { pickConsistentVoice } from "@/lib/pick-voice";

export type SpeechStatus = {
  speaking: boolean;
  muted: boolean;
  supported: boolean;
  message: string;
};

const state: SpeechStatus & { preferredVoice?: string; voiceName?: string } = {
  speaking: false, muted: false, supported: false, message: "",
};

/** Pins an explicit voice choice; empty restores automatic selection. */
export function setPreferredVoice(name: string) {
  state.preferredVoice = name || undefined;
  emit();
}

/** The voice actually in use, once something has been spoken. */
export function currentVoiceName() {
  return state.voiceName ?? "";
}
let revision = 0;
const listeners = new Set<() => void>();

function emit() {
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribeSpeech(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function speechRevision() {
  return revision;
}

export function getSpeechStatus(): SpeechStatus {
  return state;
}

function supported() {
  return typeof window !== "undefined"
    && "speechSynthesis" in window
    && "SpeechSynthesisUtterance" in window;
}

/**
 * Chrome populates the voice list asynchronously and returns [] until it does, so a voice
 * chosen on the first call would silently be ignored. Prime the list once at startup.
 */
let voicesReady = false;
export function primeVoices() {
  if (!supported() || voicesReady) return;
  state.supported = true;
  const load = () => {
    if (window.speechSynthesis.getVoices().length) voicesReady = true;
  };
  load();
  window.speechSynthesis.addEventListener?.("voiceschanged", load);
  emit();
}

/** Strips markdown so the voice reads prose rather than punctuation and syntax. */
export function toSpeakableText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, " Code block. $1. End code block. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]\s|\d+\.\s)/gm, "")
    .replace(/[|*_~]/g, "")
    // Emoji and symbols are read aloud by name ("red heart", "right arrow"); a person
    // wouldn't say them. Emoji sequences go whole: joiners, skin tones, variation selectors, flags.
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu, "")
    // Other symbols too (arrows, maths, ™, ✓), except currency, which changes the meaning.
    .replace(/(?!\p{Sc})\p{S}/gu, "")
    .replace(/[#@\\{}[\]<>^=]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

export function isMuted() {
  return state.muted;
}

export function setMuted(muted: boolean) {
  state.muted = muted;
  if (muted) cancelSpeech();
  state.message = muted ? "Speech muted." : "Speech unmuted.";
  emit();
}

export function cancelSpeech() {
  if (supported()) window.speechSynthesis.cancel();
  stopSpeaking();
  if (state.speaking) {
    state.speaking = false;
    state.message = "Speech stopped.";
  }
  emit();
}

/**
 * Speaks `text`. Returns a short status string for the caller to surface, or null when it
 * started cleanly. Safe to call from a click handler.
 */
export function speak(text: string, onDone?: () => void): string | null {
  if (!supported()) {
    state.supported = false;
    state.message = "Speech playback is not supported in this browser.";
    emit();
    return state.message;
  }
  state.supported = true;
  if (state.muted) {
    state.message = "Speech is muted.";
    emit();
    return "Speech is muted. Unmute it in Settings → Voice.";
  }

  const spoken = toSpeakableText(text).slice(0, 7000);
  if (!spoken) return null;

  window.speechSynthesis.cancel();
  stopSpeaking();

  const utterance = new SpeechSynthesisUtterance(spoken);
  const rate = 1.02;
  utterance.rate = rate;
  utterance.pitch = 0.92;

  // One voice for every language: switching per language made her sound like a different
  // person each reply. Detection still runs, but only to tell a multilingual voice which
  // language to read in — never to swap the voice itself.
  const detected = detectLanguage(spoken);
  const choice = pickConsistentVoice(window.speechSynthesis.getVoices(), state.preferredVoice);
  if (choice) {
    utterance.voice = choice.voice;
    // A single-language voice ignores or mangles a foreign `lang`, so only a multilingual
    // voice is told to switch; everything else keeps its own tag and stays intelligible.
    utterance.lang = choice.multilingual && detected ? detected : choice.voice.lang;
    state.voiceName = choice.voice.name;
  } else if (detected) {
    utterance.lang = detected;
  }

  utterance.onstart = () => {
    state.speaking = true;
    state.message = "Speaking.";
    // The caption and mouth are scheduled from the text, so they work for every language
    // including the many where the engine never fires a boundary event.
    beginUtterance(spoken, rate);
    emit();
  };
  // Where boundary events do arrive they are ground truth, and re-sync the estimate.
  utterance.onboundary = (event) => {
    if (event.name && event.name !== "word") return;
    syncBoundary(event.charIndex, spoken);
  };
  utterance.onend = () => {
    state.speaking = false;
    state.message = "Speech finished.";
    stopSpeaking();
    emit();
    onDone?.();
  };
  utterance.onerror = (event) => {
    state.speaking = false;
    state.message = event.error === "canceled" ? "Speech stopped." : "Speech playback failed.";
    stopSpeaking();
    emit();
    onDone?.();
  };

  window.speechSynthesis.speak(utterance);
  return null;
}
