/**
 * Prepares a recorded voice note: 16 kHz mono WAV, plus measured loudness.
 *
 * Browsers record WebM/Opus, which Gemini does not list as an audio input. WAV is accepted
 * by both Whisper (transcription) and Gemini (listening), and decoding it is also how the
 * note's levels are measured, so silence is detected from the audio rather than guessed
 * from an empty transcript. Browser-only (Web Audio).
 */

export type VoiceAnalysis = {
  seconds: number;
  /** Highest absolute sample, 0..1. */
  peak: number;
  /** Root-mean-square level, 0..1. */
  rms: number;
  /** Nothing above the noise floor of a quiet room and an idle microphone. */
  silent: boolean;
};

const RATE = 16_000;
/** Below these, a note is treated as silence: an idle mic, room tone, no voice. */
const SILENT_RMS = 0.006;
const SILENT_PEAK = 0.03;

export function analyse(samples: Float32Array, rate = RATE): VoiceAnalysis {
  let peak = 0;
  let sum = 0;
  for (const sample of samples) {
    const level = Math.abs(sample);
    if (level > peak) peak = level;
    sum += sample * sample;
  }
  const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
  return { seconds: samples.length / rate, peak, rms, silent: rms < SILENT_RMS && peak < SILENT_PEAK };
}

/** 16-bit PCM WAV bytes for mono samples. */
export function encodeWav(samples: Float32Array, rate = RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Decodes a recording, resamples it to 16 kHz mono, and measures it. */
export async function prepareVoice(recording: Blob): Promise<{ base64: string; analysis: VoiceAnalysis }> {
  const decoder = new AudioContext();
  try {
    const decoded = await decoder.decodeAudioData(await recording.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const samples = (await offline.startRendering()).getChannelData(0);
    return { base64: toBase64(encodeWav(samples)), analysis: analyse(samples) };
  } finally {
    void decoder.close();
  }
}
