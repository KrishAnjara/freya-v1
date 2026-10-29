"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getAttachment } from "@/lib/attachment-store";
import { playingVoiceId, playVoice, spokenSeconds, stopVoice, subscribeVoice } from "@/lib/voice-playback";

/** A recorded note: its audio lives in IndexedDB under `id`. */
export type RecordedAudio = { id: string; mime: string; seconds: number; silent?: boolean };

const BARS = 32;

/** Bar heights derived from the text, so each note keeps its own shape. Decorative only. */
function waveform(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  return Array.from({ length: BARS }, (_, index) => {
    hash = Math.imul(hash ^ (index + 1), 2654435761);
    const envelope = Math.sin((Math.PI * (index + 0.5)) / BARS) * 0.55 + 0.45;
    return Math.round((0.25 + ((hash >>> 0) % 1000) / 1000 * 0.75) * envelope * 100);
  });
}

function clock(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

type VoiceNoteProps = {
  messageId: string;
  transcript: string;
  /** Present for the user's own recordings; FREYA's notes are spoken live. */
  audio?: RecordedAudio;
  onProblem?: (message: string) => void;
};

export default function VoiceNote({ messageId, transcript, audio, onProblem }: VoiceNoteProps) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [recordingPlaying, setRecordingPlaying] = useState(false);
  const player = useRef<HTMLAudioElement | null>(null);
  const spokenId = useSyncExternalStore(subscribeVoice, playingVoiceId, () => "");
  const playing = audio ? recordingPlaying : spokenId === messageId;
  const seconds = audio ? audio.seconds : spokenSeconds(transcript);
  const bars = waveform(transcript || messageId);

  useEffect(() => () => {
    player.current?.pause();
    if (player.current?.src) URL.revokeObjectURL(player.current.src);
  }, []);

  async function toggle() {
    if (!audio) {
      if (playing) stopVoice();
      else { const problem = playVoice(messageId, transcript); if (problem) onProblem?.(problem); }
      return;
    }
    if (playing) { player.current?.pause(); return; }
    if (!player.current) {
      const stored = await getAttachment(audio.id);
      if (!stored?.data) { onProblem?.("That recording is no longer stored in this browser."); return; }
      const bytes = Uint8Array.from(atob(stored.data), (character) => character.charCodeAt(0));
      const element = new Audio(URL.createObjectURL(new Blob([bytes], { type: audio.mime })));
      element.onplay = () => setRecordingPlaying(true);
      element.onpause = () => setRecordingPlaying(false);
      element.onended = () => setRecordingPlaying(false);
      player.current = element;
    }
    stopVoice();
    void player.current.play().catch(() => onProblem?.("This browser could not play that recording."));
  }

  return (
    <div className={`voice-note ${playing ? "playing" : ""}`}>
      <div className="voice-note-row">
        <button type="button" className="voice-play" onClick={() => void toggle()} aria-label={playing ? "Pause voice message" : "Play voice message"}>
          {playing
            ? <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/></svg>
            : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10l8-5z"/></svg>}
        </button>
        <span className="voice-wave" aria-hidden="true">
          {bars.map((height, index) => <i key={index} style={{ height: `${height}%`, animationDelay: `${(index % 8) * 70}ms` }}/>)}
        </span>
        <span className="voice-duration">{clock(seconds)}</span>
      </div>
      {audio && !transcript && <div className="voice-flag">{audio.silent ? "SILENT" : "NO WORDS"}</div>}
      {transcript && <button type="button" className="voice-transcript-toggle" onClick={() => setShowTranscript((open) => !open)} aria-expanded={showTranscript}>
        {showTranscript ? "HIDE TRANSCRIPT" : "TRANSCRIPT"}
      </button>}
      {showTranscript && <p className="voice-transcript">{transcript}</p>}
    </div>
  );
}
