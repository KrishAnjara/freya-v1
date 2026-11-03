/**
 * The camera, in the browser only. A few times a second a small face model looks at a frame and
 * reports where the face is and how its muscles have moved. No frame is stored or sent anywhere: only
 * a one-word guess at their expression goes to the server. It doesn't identify anyone. The camera is
 * only started after the user switches it on, and pauses while the tab is hidden.
 */
import { readFace, type FaceExpression } from "@/lib/face-read";

// Pinned, so the code and the files it fetches always match package.json.
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const READ_EVERY_MS = 250;
/** The first start downloads the model. Past this, say it failed rather than wait forever. */
const START_LIMIT_MS = 120_000;
/** Reads in a row before an expression counts, so a flicker isn't a change of face. */
const STEADY_READS = 3;

export type FaceNow = { present: boolean; expression: FaceExpression; since: number; x: number; y: number };

let now: FaceNow = { present: false, expression: "neutral", since: 0, x: 0, y: 0 };
const listeners = new Set<() => void>();

export const getFace = () => now;

export function subscribeFace(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Where to look to meet their eyes, -1..1, for the portrait. Null with nobody there. */
export function faceGaze() {
  return now.present ? { x: now.x, y: now.y } : null;
}

function publish(next: FaceNow) {
  const changed = next.present !== now.present || next.expression !== now.expression;
  now = next;
  if (changed) listeners.forEach((listener) => listener());
}

/** Starts the camera and returns how to stop it. Rejects if the camera or the model can't load. */
export async function startFaceTracking(): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: "user" }, audio: false });
  let stopped = false;
  let timer = 0;
  let landmarker: { close: () => void } | undefined;
  const stop = () => {
    stopped = true;
    window.clearTimeout(timer);
    stream.getTracks().forEach((track) => track.stop());
    landmarker?.close();
    publish({ present: false, expression: "neutral", since: 0, x: 0, y: 0 });
  };
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks(WASM);
    // GPU only: on the CPU delegate this model ran but never found a face, which looks like it works.
    const load = FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    const tooLong = new Promise<never>((_, reject) => { window.setTimeout(() => reject(new Error("The face model took too long to load.")), START_LIMIT_MS); });
    const model = await Promise.race([load, tooLong]);
    landmarker = model;
    if (stopped) { model.close(); return stop; }
    let candidate: FaceExpression = "neutral";
    let steady = 0;
    const read = () => {
      if (stopped) return;
      timer = window.setTimeout(read, READ_EVERY_MS);
      if (document.hidden || video.readyState < 2) return;
      const result = model.detectForVideo(video, performance.now());
      const nose = result.faceLandmarks?.[0]?.[1];
      const categories = result.faceBlendshapes?.[0]?.categories;
      if (!nose || !categories) {
        if (now.present) publish({ ...now, present: false, expression: "neutral", since: Date.now() });
        return;
      }
      const shapes = Object.fromEntries(categories.map((category) => [category.categoryName, category.score]));
      const seen = readFace(shapes);
      steady = seen === candidate ? steady + 1 : 1;
      candidate = seen;
      const expression = steady >= STEADY_READS ? seen : now.expression;
      // The picture isn't mirrored: someone to the screen's right is on the image's left.
      const clamp = (value: number) => Math.max(-1, Math.min(1, value));
      publish({
        present: true,
        expression,
        since: expression === now.expression && now.present ? now.since : Date.now(),
        x: clamp((0.5 - nose.x) * 2.4),
        y: clamp((0.5 - nose.y) * 2),
      });
    };
    read();
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
