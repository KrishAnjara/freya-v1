"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as THREE from "three";
import type { MoodName, MoodState } from "@/lib/mood";
import { initialFormPose, moveForm, rotateForm, stepFormPose, zoomForm } from "@/lib/form-pose";
import { FORM_POINTS, type PointCloud } from "@/lib/visualize";
import { state as telemetry, subscribeTelemetry, telemetryRevision } from "@/lib/stream-telemetry";
import { PRESENCE_FRAGMENT, PRESENCE_VERTEX } from "@/app/components/presence-shader";
import type { Expression } from "@/lib/expression";
import type { Glance } from "@/lib/expression-director";
import { gestureOffsets, initialGestures, kickBeat, kickKey, kickPoke, kickReaction, moodHabit, stepGestures } from "@/lib/presence-gestures";

export type CanvasSignal = "idle" | "composing" | "generating" | "responding" | "interrupted";
/** How much the canvas draws: auto steps down on its own when frames run slow. */
export type CanvasQuality = "auto" | "low" | "high";

/**
 * A /visualize result shown on the canvas: loading (particles swirl), refining (the form stays
 * up while its change is made), ready, or failed. The key is the form's identity:
 * a refinement keeps it, so the form morphs in place, keeping the way it has been turned.
 */
export type CanvasForm = { key: string; title: string; status: "loading" | "refining" | "ready" | "error"; cloud?: PointCloud };
const FORM_COUNT = FORM_POINTS;

/**
 * FREYA's presence: a particle body that shows her simulated inner state.
 *
 * Every behaviour is driven by a real signal (only the timing of her mood's idle habits is left
 * to chance, in lib/presence-gestures):
 *   GESTURES   the face her portrait shows (a laugh bounces, surprise jolts, sadness sinks), a ring
 *              for each message she sends, a shimmer for their keystrokes, a poke, her mood's habits
 *              (bored sighs, restless wandering, annoyed shakes) and her glances, shared with the
 *              portrait.
 *   MOOD       the app's mood state (lib/mood): its name sets the body's shape, flow and light,
 *              energy sets breathing and size, warmth the colour temperature. Changes blend over
 *              two to three seconds; nothing jumps.
 *   LISTENING  the user is typing: the body leans towards the composer and brightens a little.
 *   THINKING   a reply was requested and nothing has arrived yet: it draws in and slowly turns.
 *   SPEAKING   streamed text arriving: a smoothed envelope of how fast it comes (not a pulse per
 *              token) brightens and quickens the surface slightly while she talks.
 *   ATTENTION  the pointer: the body turns slightly towards it.
 * The surface moves by layered noise on the GPU, so it is organic and never visibly loops.
 * The mood is a character simulation the app keeps; this shows that simulation, not feelings or
 * model internals.
 */

/** Points per quality level: inner core, surface, outer haze (any prefix keeps these proportions). */
const COUNTS = { high: 1500, medium: 1000, low: 560 } as const;
const LAYER_SHARE = { core: 0.17, haze: 0.1 };
const RADIUS = 1.05;

/** Each mood's body: how it is shaped and how it moves. Values are small on purpose. */
type MoodStyle = { scale: number; squash: number; sink: number; wave: number; waveSpeed: number; jag: number; drift: number; lean: number; glow: number; tint: [number, number, number] };
const MOOD_STYLE: Record<MoodName, MoodStyle> = {
  neutral: { scale: 1, squash: 1, sink: 0, wave: 0.012, waveSpeed: 0.6, jag: 0, drift: 0, lean: 0, glow: 0.8, tint: [0.76, 0.76, 0.74] },
  playful: { scale: 1, squash: 1, sink: 0, wave: 0.08, waveSpeed: 2.6, jag: 0, drift: 0.02, lean: 0, glow: 1, tint: [0.92, 0.7, 0.52] },
  warm: { scale: 1.05, squash: 1, sink: 0, wave: 0.02, waveSpeed: 0.8, jag: 0, drift: 0, lean: 0, glow: 1, tint: [0.95, 0.66, 0.5] },
  curious: { scale: 1, squash: 1, sink: 0, wave: 0.03, waveSpeed: 1.4, jag: 0, drift: 0.01, lean: 0.18, glow: 0.95, tint: [0.72, 0.78, 0.82] },
  happy: { scale: 1.04, squash: 1, sink: 0, wave: 0.04, waveSpeed: 1.6, jag: 0, drift: 0.01, lean: 0.05, glow: 1.05, tint: [0.96, 0.82, 0.56] },
  interested: { scale: 1.03, squash: 1, sink: 0, wave: 0.03, waveSpeed: 1.2, jag: 0, drift: 0.01, lean: 0.28, glow: 1, tint: [0.82, 0.8, 0.7] },
  horny: { scale: 1.06, squash: 1.02, sink: 0, wave: 0.07, waveSpeed: 1.8, jag: 0, drift: 0.02, lean: 0.2, glow: 1.15, tint: [0.92, 0.42, 0.46] },
  content: { scale: 1, squash: 0.97, sink: 0, wave: 0.015, waveSpeed: 0.6, jag: 0, drift: 0, lean: 0, glow: 0.85, tint: [0.8, 0.76, 0.66] },
  excited: { scale: 1.12, squash: 1.04, sink: 0, wave: 0.06, waveSpeed: 4, jag: 0.02, drift: 0.04, lean: 0.06, glow: 1.15, tint: [0.98, 0.78, 0.5] },
  bored: { scale: 0.9, squash: 0.78, sink: -0.14, wave: 0.01, waveSpeed: 0.3, jag: 0, drift: 0, lean: 0, glow: 0.55, tint: [0.62, 0.64, 0.64] },
  tired: { scale: 0.88, squash: 0.74, sink: -0.2, wave: 0.008, waveSpeed: 0.25, jag: 0, drift: 0, lean: 0, glow: 0.45, tint: [0.58, 0.6, 0.68] },
  restless: { scale: 0.98, squash: 1, sink: 0, wave: 0.04, waveSpeed: 2.2, jag: 0.015, drift: 0.07, lean: 0, glow: 0.9, tint: [0.78, 0.72, 0.7] },
  melancholy: { scale: 0.94, squash: 0.92, sink: -0.1, wave: 0.015, waveSpeed: 0.4, jag: 0, drift: 0, lean: 0, glow: 0.6, tint: [0.5, 0.58, 0.74] },
  irritated: { scale: 0.96, squash: 1, sink: 0, wave: 0.01, waveSpeed: 1, jag: 0.07, drift: 0.01, lean: 0, glow: 0.85, tint: [0.84, 0.46, 0.4] },
  annoyed: { scale: 0.97, squash: 1, sink: 0, wave: 0.015, waveSpeed: 1.6, jag: 0.04, drift: 0.02, lean: 0, glow: 0.85, tint: [0.86, 0.6, 0.38] },
  disgusted: { scale: 0.9, squash: 0.94, sink: 0, wave: 0.02, waveSpeed: 1.1, jag: 0.03, drift: 0, lean: -0.2, glow: 0.75, tint: [0.56, 0.72, 0.42] },
  sulking: { scale: 0.78, squash: 0.95, sink: -0.06, wave: 0.005, waveSpeed: 0.3, jag: 0.02, drift: 0, lean: 0, glow: 0.5, tint: [0.62, 0.52, 0.58] },
};

/** Even directions on a sphere (Fibonacci lattice). */
function sphereDirections(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < count; index += 1) {
    const y = count === 1 ? 0 : 1 - (index / (count - 1)) * 2;
    const ring = Math.sqrt(1 - y * y);
    const angle = index * golden;
    out.set([Math.cos(angle) * ring, y, Math.sin(angle) * ring], index * 3);
  }
  return out;
}

/** A small seeded random, so the body is the same on every load. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The presence's points, shuffled so that drawing only the first N (a lower quality level)
 * still covers the whole body evenly, in the same core/surface/haze proportions.
 */
function presencePoints(count: number) {
  const coreCount = Math.round(count * LAYER_SHARE.core);
  const hazeCount = Math.round(count * LAYER_SHARE.haze);
  const surfaceCount = count - coreCount - hazeCount;
  const random = mulberry32(7);
  const points: { direction: [number, number, number]; layer: number; seed: number }[] = [];
  for (const [layer, amount] of [[0, coreCount], [1, surfaceCount], [2, hazeCount]] as const) {
    const directions = sphereDirections(amount);
    for (let index = 0; index < amount; index += 1) points.push({ direction: [directions[index * 3], directions[index * 3 + 1], directions[index * 3 + 2]], layer, seed: random() });
  }
  for (let index = points.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [points[index], points[other]] = [points[other], points[index]];
  }
  const direction = new Float32Array(count * 3);
  const layer = new Float32Array(count);
  const seed = new Float32Array(count);
  points.forEach((point, index) => { direction.set(point.direction, index * 3); layer[index] = point.layer; seed[index] = point.seed; });
  return { direction, layer, seed };
}

/** A loose sphere the particles swirl on while a form is being composed. */
function swirlTargets(count: number): Float32Array {
  const unit = sphereDirections(count);
  for (let index = 0; index < unit.length; index += 1) unit[index] *= 0.7;
  return unit;
}

const POINT_VERTEX = `
attribute float size;
attribute vec3 tint;
varying vec3 vTint;
varying float vFade;
uniform float pixelRatio;
uniform float focus;
void main() {
  vTint = tint;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Depth fade around the body itself, so it stays bright wherever the camera has to sit.
  vFade = clamp(1.0 - (-mv.z - focus + 0.6) / 4.0, 0.35, 1.0);
  gl_PointSize = size * pixelRatio * (240.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const POINT_FRAGMENT = `
varying vec3 vTint;
varying float vFade;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  float core = smoothstep(0.25, 0.0, d);
  gl_FragColor = vec4(vTint * core * vFade, core);
}`;

function pointMaterial(pixelRatio: number) {
  return new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: pixelRatio }, focus: { value: 4.5 } },
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** What the presence is doing, from real signals only. */
type Activity = "idle" | "listening" | "thinking" | "speaking";
const ACTIVITY_LABEL: Record<Activity, string> = { idle: "HERE", listening: "LISTENING", thinking: "THINKING", speaking: "SPEAKING" };

function activityOf(signal: CanvasSignal): Activity {
  if (telemetry.phase === "streaming") return "speaking";
  if (telemetry.phase === "waiting" || signal === "generating") return "thinking";
  if (signal === "composing") return "listening";
  return "idle";
}

/** The starting level: weaker machines start lower, and auto steps down further if needed. */
function startingLevel(quality: CanvasQuality): keyof typeof COUNTS {
  if (quality === "low") return "low";
  if (quality === "high") return "high";
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  return cores <= 4 || memory <= 4 ? "medium" : "high";
}

export default function EmotionCanvas({ signal, mood, form = null, onClearForm, quality = "auto", reaction = null, glance = null, beat = 0, typed = 0, offline = false }: {
  signal: CanvasSignal; mood: MoodState; form?: CanvasForm | null; onClearForm?: () => void; quality?: CanvasQuality;
  /** The latest face her portrait showed (lib/expression-director); each new one moves the body. */
  reaction?: { expression: Expression; level: number; startedAt: number } | null;
  /** Where she's glancing: the body turns that way with her eyes. */
  glance?: Glance | null;
  /** Counts her messages as they post: each one runs a ring over the surface. */
  beat?: number;
  /** How much they've typed: each keystroke makes her shimmer. */
  typed?: number;
  /** Every model is down: she's dim and slow, and the label says offline instead of her mood. */
  offline?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  const signalRef = useRef(signal);
  const moodRef = useRef(mood);
  const formRef = useRef<CanvasForm | null>(form);
  const reactionRef = useRef(reaction);
  const glanceRef = useRef(glance);
  const beatRef = useRef(beat);
  const typedRef = useRef(typed);

  // Re-render on stream events so the activity label stays true.
  useSyncExternalStore(subscribeTelemetry, telemetryRevision, () => 0);
  useEffect(() => { signalRef.current = signal; }, [signal]);
  useEffect(() => { moodRef.current = mood; }, [mood]);
  useEffect(() => { formRef.current = form; }, [form]);
  useEffect(() => { reactionRef.current = reaction; }, [reaction]);
  useEffect(() => { glanceRef.current = glance; }, [glance]);
  useEffect(() => { beatRef.current = beat; }, [beat]);
  useEffect(() => { typedRef.current = typed; }, [typed]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setFallback(true); return; }
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" }); }
    catch { setFallback(true); return; }

    let level = startingLevel(quality);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, level === "low" ? 1 : 1.5);
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x050607, 0);
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x050607, 0.11);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
    const rig = new THREE.Group();
    scene.add(rig);

    // Presence: built once at the highest count; a lower level draws a prefix of it.
    const points = presencePoints(COUNTS.high);
    const presenceGeometry = new THREE.BufferGeometry();
    // Three needs a position attribute to draw; the shader places every point from `direction`.
    presenceGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points.direction), 3));
    presenceGeometry.setAttribute("direction", new THREE.BufferAttribute(points.direction, 3));
    presenceGeometry.setAttribute("layer", new THREE.BufferAttribute(points.layer, 1));
    presenceGeometry.setAttribute("seed", new THREE.BufferAttribute(points.seed, 1));
    presenceGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
    presenceGeometry.setDrawRange(0, COUNTS[level]);
    const uniforms = {
      time: { value: 0 }, flow: { value: 0.09 }, radius: { value: RADIUS }, amplitude: { value: 0.04 }, detail: { value: 1 },
      squash: { value: 1 }, sink: { value: 0 }, lift: { value: 0 }, spin: { value: 0 }, speak: { value: 0 }, shiver: { value: 0 },
      brightness: { value: 1 }, tint: { value: new THREE.Vector3(0.76, 0.76, 0.74) }, lightDir: { value: new THREE.Vector3(-0.45, 0.6, 0.7) },
      pixelRatio: { value: pixelRatio }, focus: { value: 4.5 },
      pulse: { value: 0 }, pulseAge: { value: 9 }, gaze: { value: new THREE.Vector3() },
    };
    const presenceMaterial = new THREE.ShaderMaterial({ uniforms, vertexShader: PRESENCE_VERTEX, fragmentShader: PRESENCE_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const presence = new THREE.Points(presenceGeometry, presenceMaterial);
    rig.add(presence);

    // Visualised form (/visualize): its own point cloud, spinning slowly so it reads as 3D.
    const formPositions = new Float32Array(FORM_COUNT * 3);
    const formTint = new Float32Array(FORM_COUNT * 3);
    const formSize = new Float32Array(FORM_COUNT);
    const formColors = new Float32Array(FORM_COUNT * 3).fill(0.8);
    const swirl = swirlTargets(FORM_COUNT);
    let formTargets: Float32Array = swirl;
    let formKey = "";
    let formStatus = "";
    let formCloud: PointCloud | undefined;
    let poseKey = "";
    const pose = initialFormPose();
    // Fingers or the mouse currently on the form, by pointer id.
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;
    let lastDragAt = 0;
    let formLevel = 0;
    const formGeometry = new THREE.BufferGeometry();
    formGeometry.setAttribute("position", new THREE.BufferAttribute(formPositions, 3));
    formGeometry.setAttribute("tint", new THREE.BufferAttribute(formTint, 3));
    formGeometry.setAttribute("size", new THREE.BufferAttribute(formSize, 1));
    formGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
    const formMaterial = pointMaterial(pixelRatio);
    const formGroup = new THREE.Group();
    formGroup.visible = false;
    formGroup.add(new THREE.Points(formGeometry, formMaterial));
    rig.add(formGroup);

    // Speaking: how fast real text is arriving, smoothed into an envelope.
    let seenFragments = 0;
    let seenStart = -1;
    let arrivedChars = 0;
    let speak = 0;
    // Smoothed state, so moods and activities blend instead of jumping.
    const style = { ...MOOD_STYLE.neutral };
    let energy = 0.55;
    let warmth = 0.5;
    let listen = 0;
    let think = 0;
    let shiver = 0;
    let spin = 0;
    // Gestures (lib/presence-gestures): reactions, her messages, their typing, a poke, mood habits.
    // Whatever was already true when the canvas opened isn't news, so it doesn't fire.
    const gestures = initialGestures();
    let seenReaction = reactionRef.current?.startedAt ?? 0;
    let seenBeat = beatRef.current;
    let seenTyped = typedRef.current;
    let lookX = 0;
    let lookY = 0;

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      const halfAngle = Math.tan((camera.fov * Math.PI) / 360);
      // Framed by the smaller side, so the body fills the canvas whatever shape the layout gives it.
      camera.position.z = 1.75 / (halfAngle * Math.min(1, camera.aspect));
      camera.updateProjectionMatrix();
      uniforms.focus.value = camera.position.z;
      formMaterial.uniforms.focus.value = camera.position.z;
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    let pointerX = 0;
    let pointerY = 0;
    // Only a visualised form can be handled; FREYA's own presence just notices the pointer.
    const formInHand = () => {
      const status = formRef.current?.status;
      return status === "ready" || status === "refining";
    };
    const worldPerPixel = () => {
      const bounds = host.getBoundingClientRect();
      return (2 * camera.position.z * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, bounds.height);
    };
    const onMove = (event: PointerEvent) => {
      const bounds = host.getBoundingClientRect();
      pointerX = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointerY = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      const held = pointers.get(event.pointerId);
      if (!held) return;
      const deltaX = event.clientX - held.x;
      const deltaY = event.clientY - held.y;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2) {
        // Two fingers: pinch to zoom, and move together to drag.
        const [first, second] = [...pointers.values()];
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        if (pinchDistance > 0) zoomForm(pose, distance / pinchDistance);
        pinchDistance = distance;
        moveForm(pose, (deltaX / 2) * worldPerPixel(), (-deltaY / 2) * worldPerPixel());
      } else if (event.shiftKey || (event.buttons & 2)) {
        moveForm(pose, deltaX * worldPerPixel(), -deltaY * worldPerPixel());
      } else {
        const now = performance.now();
        rotateForm(pose, deltaX, deltaY, (now - lastDragAt) / 1000);
        lastDragAt = now;
      }
    };
    const onLeave = () => { pointerX = 0; pointerY = 0; };
    const onDown = (event: PointerEvent) => {
      // Her own presence can't be dragged about, but it notices being poked.
      if (!formInHand()) { if (!formRef.current) kickPoke(gestures); return; }
      host.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      pinchDistance = 0;
      lastDragAt = performance.now();
      pose.spin = 0;
      host.classList.add("is-holding");
    };
    const onUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      pinchDistance = 0;
      if (!pointers.size) {
        host.classList.remove("is-holding");
        // A hand that stopped before letting go isn't a flick.
        if (performance.now() - lastDragAt > 90) pose.spin = 0;
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (!formInHand()) return;
      event.preventDefault();
      zoomForm(pose, Math.exp(-event.deltaY * 0.0012));
    };
    const onMenu = (event: Event) => { if (formInHand()) event.preventDefault(); };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("contextmenu", onMenu);

    let animation = 0;
    let lastFrame = 0;
    let onScreen = true;
    let hasBeenVisible = false;
    // Auto quality: frames that come too slowly while she's active step the point count down.
    let slowFrames = 0;
    let measuredFrames = 0;

    const render = (timestamp: number) => {
      animation = window.requestAnimationFrame(render);
      const activity = activityOf(signalRef.current);
      // A resting presence only breathes; half the frame rate saves power.
      if (activity === "idle" && !formRef.current && timestamp - lastFrame < 32) return;
      const interval = lastFrame ? timestamp - lastFrame : 16;
      const dt = Math.min(0.1, interval / 1000);
      lastFrame = timestamp;
      const t = timestamp / 1000;
      // Moods reshape the body over two to three seconds.
      const blend = 1 - Math.exp(-dt * 0.9);

      if (quality === "auto" && activity !== "idle" && level !== "low") {
        measuredFrames += 1;
        if (interval > 26) slowFrames += 1;
        if (measuredFrames >= 120) {
          if (slowFrames > 60) {
            level = level === "high" ? "medium" : "low";
            presenceGeometry.setDrawRange(0, COUNTS[level]);
          }
          measuredFrames = 0;
          slowFrames = 0;
        }
      }

      // Mood: ease towards the current mood's body, energy and warmth.
      const currentMood = moodRef.current;
      const target = MOOD_STYLE[currentMood.name] ?? MOOD_STYLE.neutral;
      for (const key of Object.keys(target) as (keyof MoodStyle)[]) {
        if (key === "tint") style.tint = style.tint.map((value, channel) => value + (target.tint[channel] - value) * blend) as MoodStyle["tint"];
        else (style[key] as number) += ((target[key] as number) - (style[key] as number)) * blend;
      }
      energy += (currentMood.energy - energy) * blend;
      warmth += (currentMood.warmth - warmth) * blend;
      listen += ((activity === "listening" ? 1 : 0) - listen) * (1 - Math.exp(-dt * 3));
      think += ((activity === "thinking" ? 1 : 0) - think) * (1 - Math.exp(-dt * 2));
      shiver *= Math.exp(-dt * 3);
      if (telemetry.phase === "error" || telemetry.phase === "aborted" || signalRef.current === "interrupted") shiver = Math.max(shiver, telemetry.endedAt !== null && performance.now() - (telemetry.startedAt + telemetry.endedAt) < 600 ? 1 : 0);
      // The turn only ever moves forward, so it stops where it is instead of spinning back.
      spin += dt * think * 0.7;

      // Speaking: characters per second of real streamed text, eased into a 0..1 envelope.
      if (telemetry.startedAt !== seenStart) { seenStart = telemetry.startedAt; seenFragments = 0; }
      while (seenFragments < telemetry.fragments.length) {
        arrivedChars += telemetry.fragments[seenFragments].text.length || 1;
        seenFragments += 1;
      }
      const rate = arrivedChars / Math.max(dt, 0.001);
      arrivedChars = 0;
      const speakTarget = activity === "speaking" ? Math.min(1, 0.35 + rate / 400) : 0;
      speak += (speakTarget - speak) * (1 - Math.exp(-dt * (speakTarget > speak ? 3 : 1.2)));

      // Form on stage: the presence all but disappears, so the form reads cleanly.
      const shownForm = formRef.current;
      const formActive = Boolean(shownForm && shownForm.status !== "error");
      formLevel += ((formActive ? 1 : 0) - formLevel) * (1 - Math.exp(-dt * 2.4));

      // What just happened moves her: a new face, a message she sent, a key they pressed.
      const reaction = reactionRef.current;
      if (reaction && reaction.startedAt !== seenReaction) {
        seenReaction = reaction.startedAt;
        kickReaction(gestures, reaction.expression, reaction.level, t);
      }
      if (beatRef.current !== seenBeat) { seenBeat = beatRef.current; kickBeat(gestures); }
      if (typedRef.current !== seenTyped) { if (typedRef.current > seenTyped) kickKey(gestures); seenTyped = typedRef.current; }
      moodHabit(gestures, currentMood.name, t, (activity === "idle" || activity === "listening") && !formActive);
      stepGestures(gestures, dt);
      const move = gestureOffsets(gestures, t);
      // Her glance (shared with the portrait): the body turns and swells a little that way.
      const glancing = glanceRef.current;
      lookX += ((glancing?.x ?? 0) - lookX) * (1 - Math.exp(-dt * 4));
      lookY += ((glancing?.y ?? 0) - lookY) * (1 - Math.exp(-dt * 4));
      (uniforms.gaze.value as THREE.Vector3).set(lookX, lookY, 0.25 * Math.hypot(lookX, lookY));
      uniforms.pulse.value = move.pulse;
      uniforms.pulseAge.value = move.pulseAge;
      // Her mood's own drift: restless wanders, excited fidgets, calm moods barely move.
      const drift = style.drift * 2.2 * (1 - formLevel);
      presence.position.set(
        move.x + (Math.sin(t * 0.83 + 1.1) * 0.6 + Math.sin(t * 0.31 + 4.2) * 0.4) * drift,
        move.y + (Math.sin(t * 0.67 + 2.3) * 0.6 + Math.sin(t * 0.23) * 0.4) * drift * 0.6,
        move.z,
      );
      presence.rotation.z = move.roll;

      const breathRate = 0.45 + energy * 1.1;
      const breath = 1 + (0.022 + energy * 0.03) * Math.sin(t * breathRate);
      const warmTint: [number, number, number] = [0.98, 0.72, 0.52];
      const coolTint: [number, number, number] = [0.55, 0.64, 0.76];
      const temperature = style.tint.map((value, channel) => {
        const mood = value * 0.6 + (coolTint[channel] + (warmTint[channel] - coolTint[channel]) * warmth) * 0.4;
        return mood + (warmTint[channel] - mood) * move.warm * 0.5;
      });
      uniforms.time.value = t;
      // Calm moods flow slowly; lively ones a little faster. Speech quickens it slightly.
      uniforms.flow.value = 0.05 + style.waveSpeed * 0.055 + speak * 0.05 + move.shimmer * 0.04;
      uniforms.radius.value = RADIUS * style.scale * (0.62 + 0.38 * energy) * breath * (1 - 0.16 * think) * (1 - 0.35 * formLevel) * move.scale;
      uniforms.amplitude.value = 0.035 + style.wave * 0.9 + style.drift * 0.6 + speak * 0.02 + move.shimmer * 0.025;
      uniforms.detail.value = 0.6 + style.jag * 8;
      uniforms.squash.value = style.squash;
      uniforms.sink.value = style.sink;
      uniforms.lift.value = listen * 0.1;
      uniforms.spin.value = spin;
      uniforms.speak.value = speak;
      uniforms.shiver.value = shiver;
      // Restrained: brighter while listening or talking, never glaring.
      uniforms.brightness.value = (0.62 + 0.42 * style.glow + 0.18 * listen + 0.12 * think + 0.12 * speak + 0.3 * move.glow) * (1 - 0.96 * formLevel);
      (uniforms.tint.value as THREE.Vector3).set(temperature[0], temperature[1], temperature[2]);
      presence.visible = formLevel < 0.995;

      // Visualised form: swirl while composing, settle into the shape, fade out when cleared.
      // A different form starts from a clean pose; a refinement of this one keeps it.
      if ((shownForm?.key ?? "") !== poseKey) {
        poseKey = shownForm?.key ?? "";
        Object.assign(pose, initialFormPose());
        pointers.clear();
        host.classList.remove("is-holding");
        formCloud = undefined;
      }
      const nextKey = shownForm ? `${shownForm.key}:${shownForm.status}` : "";
      if (nextKey !== formKey) {
        formKey = nextKey;
        formStatus = shownForm?.status ?? "";
        if (shownForm?.status === "loading") {
          formTargets = swirl;
          formColors.fill(0.78);
          formCloud = undefined;
        }
      }
      if (shownForm?.cloud && shownForm.cloud !== formCloud) {
        formCloud = shownForm.cloud;
        formTargets = formCloud.positions;
        formColors.set(formCloud.colors.subarray(0, FORM_COUNT * 3));
      }
      // Hidden, not just black: colourless points still write alpha, leaving a dark outline.
      formGroup.visible = formLevel > 0.002;
      if (formGroup.visible) {
        const settle = 1 - Math.exp(-dt * (formStatus === "loading" ? 1.4 : 2.2));
        const glow = formStatus === "loading" ? 0.35 + 0.15 * Math.sin(t * 3) : formStatus === "refining" ? 0.75 + 0.2 * Math.sin(t * 3) : 0.95;
        for (let index = 0; index < FORM_COUNT * 3; index += 1) {
          formPositions[index] += (formTargets[index] - formPositions[index]) * settle;
          formTint[index] = formColors[index] * glow * formLevel;
        }
        formSize.fill((formStatus === "loading" ? 0.03 : 0.038) * Math.min(1, formLevel * 1.4));
        if (formStatus === "loading") pose.yaw += dt * 1.2;
        stepFormPose(pose, dt, pointers.size > 0);
        formGroup.rotation.set(pose.pitch, pose.yaw, 0);
        formGroup.position.set(pose.panX, pose.panY, 0);
        formGroup.scale.setScalar(pose.zoom);
        formGeometry.getAttribute("position").needsUpdate = true;
        formGeometry.getAttribute("tint").needsUpdate = true;
        formGeometry.getAttribute("size").needsUpdate = true;
      }

      // Attention: the body turns towards the pointer; curious moods lean in further.
      // With a form on stage the pointer belongs to the form, so the scene itself holds still.
      const reach = 0.3 + style.lean;
      const noticeX = formInHand() ? 0 : pointerX;
      const noticeY = formInHand() ? 0 : pointerY;
      const look = 1 - formLevel;
      rig.rotation.y += (noticeX * reach + Math.sin(t * 0.07) * 0.1 * look + lookX * 0.45 * look - rig.rotation.y) * (1 - Math.exp(-dt * 1.2));
      rig.rotation.x += (noticeY * -0.18 - listen * 0.15 - move.shimmer * 0.05 + Math.sin(t * 0.05) * 0.04 * look - lookY * 0.22 * look - rig.rotation.x) * (1 - Math.exp(-dt * 1.2));
      renderer.render(scene, camera);
    };

    const start = () => { if (!animation) { lastFrame = 0; animation = window.requestAnimationFrame(render); } };
    const stop = () => { window.cancelAnimationFrame(animation); animation = 0; };
    const sync = () => { if (document.hidden || !onScreen) stop(); else start(); };
    document.addEventListener("visibilitychange", sync);
    const intersection = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (visible) hasBeenVisible = true;
      // A false negative before first paint must not freeze the canvas.
      onScreen = visible || !hasBeenVisible;
      sync();
    });
    intersection.observe(host);
    start();

    return () => {
      stop();
      resizeObserver.disconnect();
      intersection.disconnect();
      document.removeEventListener("visibilitychange", sync);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("contextmenu", onMenu);
      for (const geometry of [presenceGeometry, formGeometry]) geometry.dispose();
      for (const material of [presenceMaterial, formMaterial]) material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [quality]);

  const activity = activityOf(signal);
  return <section
    className={`emotion-canvas presence-canvas signal-${signal} activity-${activity} mood-${mood.name}`}
    aria-label={offline ? "FREYA is offline." : `FREYA's presence: ${ACTIVITY_LABEL[activity].toLowerCase()}, mood ${mood.name}. Shows the app's simulated mood and conversation state.`}
  >
    {fallback && <div className="canvas-fallback" aria-hidden="true"><span>✧</span><i/><i/><i/><i/><i/><i/><i/><i/></div>}
    <div ref={hostRef} className={`three-host ${form?.status === "ready" || form?.status === "refining" ? "form-in-hand" : ""}`} aria-hidden="true" />
    <div className="presence-status" aria-hidden="true">{offline ? "OFFLINE" : `${ACTIVITY_LABEL[activity]} · ${mood.name.toUpperCase()}`}</div>
    {form && <div className={`form-caption form-${form.status}`} role="status" aria-live="polite">
      <span>{form.status === "loading" ? `Composing · ${form.title}…` : form.status === "refining" ? `Refining · ${form.title}…` : form.status === "error" ? `Couldn't visualise ${form.title}` : `${form.title}${fallback ? " · 3D view needs motion enabled" : ""}`}</span>
      {form.status !== "loading" && form.status !== "refining" && onClearForm && <button type="button" onClick={onClearForm} aria-label="Clear the visualisation">Clear</button>}
    </div>}
  </section>;
}
