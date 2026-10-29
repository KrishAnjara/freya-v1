"use client";

import { useEffect, useRef, useState } from "react";

/** A minute: as 16 kHz WAV that is ~2.6 MB of base64, inside both upload limits. */
const MAX_SECONDS = 60;

function preferredType() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

type VoiceRecorderProps = {
  disabled?: boolean;
  onRecorded: (audio: Blob, seconds: number) => void;
  onProblem: (message: string) => void;
};

/** Hold-free recording: tap the mic, talk, tap send (or ×). */
export default function VoiceRecorder({ disabled, onRecorded, onProblem }: VoiceRecorderProps) {
  const [elapsed, setElapsed] = useState(0);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const keep = useRef(false);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const seconds = (performance.now() - startedAt.current) / 1000;
      setElapsed(seconds);
      // At the limit the note is sent as it is, not thrown away.
      if (seconds >= MAX_SECONDS && recorder.current?.state === "recording") {
        keep.current = true;
        recorder.current.stop();
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [recording]);

  // Never leave the microphone open after the composer goes away.
  useEffect(() => () => { keep.current = false; recorder.current?.stop(); }, []);

  async function begin() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onProblem("This browser cannot record audio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = preferredType();
      const media = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      media.ondataavailable = (event) => { if (event.data.size) chunks.current.push(event.data); };
      media.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const seconds = (performance.now() - startedAt.current) / 1000;
        setRecording(false);
        setElapsed(0);
        if (keep.current && seconds >= 0.3 && chunks.current.length) {
          onRecorded(new Blob(chunks.current, { type: media.mimeType || type || "audio/webm" }), seconds);
        }
      };
      recorder.current = media;
      startedAt.current = performance.now();
      keep.current = false;
      media.start(250);
      setRecording(true);
      window.dispatchEvent(new Event("freya:stop-listening"));
    } catch {
      onProblem("Microphone access was blocked. Allow it in the browser's site settings.");
    }
  }

  function finish(send: boolean) {
    keep.current = send;
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  if (!recording) {
    return <button type="button" className="mic-button" onClick={() => void begin()} disabled={disabled} aria-label="Record a voice message" title="Record a voice message">
      <svg aria-hidden="true" viewBox="0 0 16 16"><rect x="5.5" y="1.8" width="5" height="8.4" rx="2.5"/><path d="M3.2 7.6a4.8 4.8 0 0 0 9.6 0M8 12.4v2"/></svg>
    </button>;
  }
  return (
    <div className="recording-bar" role="status" aria-live="polite">
      <button type="button" className="recording-cancel" onClick={() => finish(false)} aria-label="Discard recording">×</button>
      <span className="recording-dot" aria-hidden="true"/>
      <span className="recording-time">{Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, "0")}</span>
      <span className="recording-label">RECORDING · TAP ↑ TO SEND</span>
      <button type="button" className="send-button" onClick={() => finish(true)} aria-label="Send voice message">↑</button>
    </div>
  );
}
