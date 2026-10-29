export type CanvasShape = "auto" | "wave" | "graph" | "face" | "bike" | "dog";
export type CanvasMood = "curious" | "joyful" | "frustrated" | "sad" | "calm" | "surprised";
export type CanvasVisual = { shape: Exclude<CanvasShape, "auto">; mood: CanvasMood; label: string };

export function deriveCanvasVisual(prompt: string, selected: CanvasShape = "auto"): CanvasVisual {
  const text = prompt.toLowerCase();
  const shape: CanvasVisual["shape"] = selected !== "auto" ? selected
    : /\b(bike|bicycle|cycling|cycle)\b/.test(text) ? "bike"
      : /\b(dog|puppy|canine)\b/.test(text) ? "dog"
        : /\b(graph|chart|plot|data|statistics|trend)\b/.test(text) ? "graph"
          : /\b(face|portrait|expression|emoji)\b/.test(text) ? "face"
            : "wave";
  const mood: CanvasMood = /\b(angry|furious|mad|annoyed|frustrat(?:ed|ing)|pissed)\b/.test(text) ? "frustrated"
    : /\b(sad|upset|lonely|grieving|heartbroken)\b/.test(text) ? "sad"
      : /\b(excited|thrilled|delighted|happy|joyful|awesome)\b/.test(text) ? "joyful"
        : /\b(surprised|shocked|astonished|unexpected)\b/.test(text) ? "surprised"
          : /\b(calm|relaxed|peaceful|quiet)\b/.test(text) ? "calm"
            : "curious";
  const names = { wave: "flowing field", graph: "data graph", face: "expressive face", bike: "bicycle", dog: "dog" };
  return { shape, mood, label: `${names[shape]} · ${mood} tone cue` };
}
