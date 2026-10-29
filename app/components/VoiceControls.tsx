"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { stopSpeaking } from "@/lib/mouth-drive";
import {
  cancelSpeech,
  getSpeechStatus,
  isMuted,
  primeVoices,
  setMuted,
  speak,
  speechRevision,
  subscribeSpeech,
} from "@/lib/speech";

type RecognitionResult = { isFinal: boolean; [index: number]: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type RecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionConstructor = new () => RecognitionLike;
type SpeechWindow = Window & {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
};

export type SpeechRequest = { id: number; text: string } | null;

export default function VoiceControls({
  speechRequest,
  onTranscript,
  onInterrupt,
  privacyMode = false,
}: {
  speechRequest: SpeechRequest;
  onTranscript: (text: string) => void;
  onInterrupt: () => void;
  privacyMode?: boolean;
}) {
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const lastSpokenId = useRef<number | null>(null);
  const [listening, setListening] = useState(false);
  const [recognitionAvailable, setRecognitionAvailable] = useState(false);
  const [localStatus, setLocalStatus] = useState("");

  // Playback state lives in lib/speech so it survives this panel being unmounted.
  useSyncExternalStore(subscribeSpeech, speechRevision, () => 0);
  const speechState = getSpeechStatus();

  useEffect(() => {
    primeVoices();
    const speechWindow = window as SpeechWindow;
    setRecognitionAvailable(Boolean(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition));
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  // Kept for callers that still queue speech through props rather than calling speak().
  useEffect(() => {
    if (!speechRequest) return;
    if (lastSpokenId.current === speechRequest.id) return;
    lastSpokenId.current = speechRequest.id;
    const problem = speak(speechRequest.text);
    if (problem) setLocalStatus(problem);
  }, [speechRequest]);

  useEffect(() => {
    const stopListener = () => {
      recognitionRef.current?.stop();
      setListening(false);
    };
    window.addEventListener("freya:stop-listening", stopListener);
    return () => window.removeEventListener("freya:stop-listening", stopListener);
  }, []);

  useEffect(() => {
    if (!privacyMode) return;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setListening(false);
  }, [privacyMode]);

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      setListening(false);
      setLocalStatus("Voice input stopped.");
      return;
    }

    const speechWindow = window as SpeechWindow;
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      setLocalStatus("Voice input is not supported in this browser. You can still use voice playback or type.");
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    let interruptedForUtterance = false;
    recognition.onresult = (event) => {
      const results = Array.from(event.results).slice(event.resultIndex);
      const interim = results.filter((result) => !result.isFinal)
        .map((result) => result[0]?.transcript?.trim() ?? "").filter(Boolean).join(" ");
      if (interim && !interruptedForUtterance) {
        // Interim recognition is the browser's available speech-onset signal. Stop playback
        // and obsolete model work as soon as it detects the user's new utterance.
        cancelSpeech();
        onInterrupt();
        interruptedForUtterance = true;
        setLocalStatus("New speech detected. FREYA stopped; listening for the rest of your utterance.");
      }
      const transcript = results
        .filter((result) => result.isFinal)
        .map((result) => result[0]?.transcript?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      if (transcript) {
        cancelSpeech();
        onInterrupt();
        onTranscript(transcript);
        setLocalStatus("Speech recognized. Review the transcript, then send when ready.");
        interruptedForUtterance = false;
      }
    };
    recognition.onerror = (event) => {
      setLocalStatus(event.error === "not-allowed" ? "Microphone permission was denied." : `Voice input stopped (${event.error || "recognition error"}).`);
      setListening(false);
      recognitionRef.current = null;
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
      setLocalStatus("Voice input is listening. Press the mic again to stop.");
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setLocalStatus("Could not start voice input. Check microphone permission and try again.");
    }
  }

  function stopSpeech() {
    cancelSpeech();
    stopSpeaking();
    setLocalStatus(listening ? "Speech stopped; voice input remains active." : "Speech stopped.");
  }

  const status = localStatus || speechState.message;

  return (
    <div className="voice-controls" aria-label="Voice controls">
      <button type="button" onClick={toggleListening} aria-pressed={listening} disabled={!recognitionAvailable || privacyMode} title={privacyMode ? "Browser speech recognition may send audio to its vendor, so it is disabled in local-only mode" : recognitionAvailable ? "Voice input; recognized new speech interrupts generation or playback" : "Voice input is not supported in this browser"}>
        {listening ? "■ Stop mic" : "🎙 Voice"}
      </button>
      <button type="button" onClick={stopSpeech} aria-label="Stop speech playback">Stop voice</button>
      <button type="button" onClick={() => setMuted(!isMuted())} aria-pressed={speechState.muted}>{speechState.muted ? "Unmute" : "Mute"}</button>
      <span className="voice-status" role="status" aria-live="polite">{privacyMode ? "Voice recognition is disabled in local-only mode because the browser may use a remote speech service." : status || "Voice is optional; recognition depends on browser support."}</span>
    </div>
  );
}
