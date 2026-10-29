/**
 * A short two-note chime for incoming messages, synthesised with Web Audio (no asset).
 * Browsers only allow sound after the user has interacted with the page, which sending a
 * message always is; before that, the chime fails silently.
 */

let context: AudioContext | null = null;
let lastPlayed = 0;

export function playChime() {
  // A burst of parts arriving together chimes once, not five times.
  const now = Date.now();
  if (now - lastPlayed < 900) return;
  lastPlayed = now;
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume();
    const start = context.currentTime + 0.01;
    for (const [offset, frequency] of [[0, 880], [0.09, 1320]] as const) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start + offset);
      gain.gain.linearRampToValueAtTime(0.06, start + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.28);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.3);
    }
  } catch {
    // No audio available; the visual notification still shows.
  }
}
