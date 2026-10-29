"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as THREE from "three";
import type { CanvasVisual } from "@/lib/canvas-visual";
import {
  MAX_FRAGMENTS,
  MAX_LINKS,
  state as telemetry,
  streamStats,
  subscribeTelemetry,
  telemetryRevision,
} from "@/lib/stream-telemetry";

export type CanvasSignal = "idle" | "composing" | "generating" | "responding" | "interrupted";

/**
 * Activity canvas: a visualization of the response stream, not of the model's mind.
 *
 * What each element means — and the on-canvas legend says the same:
 *   MEASURED      Each streamed chunk becomes a node on the thread, placed by its real arrival
 *                 time (client clock), sized by its real length. Each chunk also fires exactly
 *                 one pulse through the lattice; nothing pulses without a chunk.
 *   DERIVED       Lines between thread nodes are lexical links: a later chunk reusing a word
 *                 from an earlier chunk (or the prompt). String matching, not attention.
 *   ILLUSTRATIVE  The four-layer lattice and its wiring are scaffolding with no counterpart in
 *                 the real model. Which lattice nodes a pulse lights is a hash of the chunk's
 *                 text: deterministic, but arbitrary.
 *
 * Groq, Gemini and Ollama expose no activations, attention or hidden reasoning through this
 * app's API, so none are shown or simulated as such.
 */

const SIGNAL_LABELS: Record<CanvasSignal, string> = {
  idle: "IDLE",
  composing: "INPUT · COMPOSING",
  generating: "STREAM · OPEN",
  responding: "STREAM · CLOSED",
  interrupted: "STREAM · INTERRUPTED",
};

// --- idle forms (unchanged feature: the canvas still takes the topic's shape when quiet) -------

type Point = [number, number];
type Segment = [Point, Point];

function line(points: Point[]): Segment[] {
  return points.slice(1).map((point, index) => [points[index], point]);
}

function circle(cx: number, cy: number, radius: number, count = 80, from = 0, to = Math.PI * 2): Point[] {
  return Array.from({ length: count + 1 }, (_, index) => {
    const angle = from + ((to - from) * index) / count;
    return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
  });
}

function drawSegments(visual: CanvasVisual): Segment[] {
  const segments: Segment[] = [];
  const add = (points: Point[]) => segments.push(...line(points));
  if (visual.shape === "graph") {
    add([[-1.45, -0.9], [-1.45, 0.85], [-1.35, 0.85]]);
    add([[-1.45, -0.9], [1.45, -0.9]]);
    [0.48, 0.9, 0.68, 1.18, 0.98].forEach((height, index) => {
      const x = -1.05 + index * 0.48;
      add([[x, -0.84], [x, -0.84 + height], [x + 0.2, -0.84 + height]]);
    });
    add(Array.from({ length: 72 }, (_, index) => {
      const x = -1.25 + index * (2.55 / 71);
      return [x, -0.45 + Math.sin(index * 0.105) * 0.35 + x * 0.18] as Point;
    }));
  } else if (visual.shape === "face") {
    add(circle(0, 0, 0.95));
    add(circle(-0.35, 0.23, 0.085, 18));
    add(circle(0.35, 0.23, 0.085, 18));
    add([[-0.56, 0.48], [-0.35, 0.55], [-0.15, 0.48]]);
    add([[0.15, 0.48], [0.35, 0.55], [0.56, 0.48]]);
    const smile = visual.mood === "joyful" || visual.mood === "curious";
    const frown = visual.mood === "sad" || visual.mood === "frustrated";
    add(Array.from({ length: 32 }, (_, index) => {
      const x = -0.4 + index * (0.8 / 31);
      const curve = smile ? -0.2 + 0.42 * (x / 0.4) ** 2 : frown ? 0.18 - 0.3 * (x / 0.4) ** 2 : 0;
      return [x, -0.32 + curve] as Point;
    }));
  } else if (visual.shape === "bike") {
    add(circle(-0.92, -0.36, 0.58));
    add(circle(0.92, -0.36, 0.58));
    const rear: Point = [-0.92, -0.36];
    const front: Point = [0.92, -0.36];
    const crank: Point = [0.02, -0.36];
    const seat: Point = [-0.36, 0.56];
    const bar: Point = [0.62, 0.52];
    add([rear, seat, crank, rear]);
    add([seat, [-0.05, 0.58], bar, front]);
    add([bar, [0.82, 0.64]]);
    add([seat, [-0.53, 0.7]]);
    add([crank, [0.16, -0.24], [0.3, -0.36], crank]);
  } else if (visual.shape === "dog") {
    add(circle(0, -0.02, 0.76));
    add([[-0.52, 0.48], [-0.84, 1.1], [-0.18, 0.84], [-0.52, 0.48]]);
    add([[0.52, 0.48], [0.84, 1.1], [0.18, 0.84], [0.52, 0.48]]);
    add(circle(-0.28, 0.15, 0.065, 16));
    add(circle(0.28, 0.15, 0.065, 16));
    add([[-0.38, -0.27], [-0.22, -0.5], [0, -0.56], [0.22, -0.5], [0.38, -0.27]]);
    add([[-0.11, -0.18], [0, -0.28], [0.11, -0.18], [0, -0.08], [-0.11, -0.18]]);
    add([[0, -0.28], [0, -0.48]]);
  } else {
    add(Array.from({ length: 180 }, (_, index) => {
      const x = -1.8 + index * (3.6 / 179);
      return [x, Math.sin(index * 0.12) * 0.45 + Math.sin(index * 0.035) * 0.2] as Point;
    }));
    add(Array.from({ length: 100 }, (_, index) => {
      const angle = index * 0.16;
      const radius = 0.12 + index * 0.012;
      return [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.7] as Point;
    }));
  }
  return segments;
}

function sampleShape(visual: CanvasVisual, count: number): Float32Array {
  const segments = drawSegments(visual);
  const lengths = segments.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]));
  const total = lengths.reduce((sum, length) => sum + length, 0) || 1;
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    let distance = (index / count) * total;
    let selected = 0;
    while (selected < segments.length - 1 && distance > lengths[selected]) distance -= lengths[selected++];
    const [a, b] = segments[selected];
    const t = Math.max(0, Math.min(1, distance / (lengths[selected] || 1)));
    positions[index * 3] = a[0] + (b[0] - a[0]) * t;
    positions[index * 3 + 1] = a[1] + (b[1] - a[1]) * t;
    positions[index * 3 + 2] = Math.sin(index * 1.7) * 0.07;
  }
  return positions;
}

// Desaturated mood tints for the idle form; the activity palette stays bone and rust.
const MOOD_TINT: Record<CanvasVisual["mood"], [number, number, number]> = {
  curious: [0.62, 0.64, 0.63],
  joyful: [0.72, 0.62, 0.48],
  frustrated: [0.66, 0.42, 0.4],
  sad: [0.46, 0.52, 0.64],
  calm: [0.5, 0.64, 0.6],
  surprised: [0.62, 0.52, 0.68],
};
const BONE: [number, number, number] = [0.85, 0.82, 0.76];
const RUST: [number, number, number] = [0.72, 0.16, 0.13];

// --- illustrative lattice ----------------------------------------------------------------------

const LAYERS = 4;
const PER_LAYER = 96;
const LATTICE = LAYERS * PER_LAYER;
const EDGES_PER_NODE = 2;
const LAYER_X = [-1.2, -0.4, 0.4, 1.2];
const LAYER_STEP_MS = 120;
/** Chunks arriving within this window share one pulse. */
const PULSE_WINDOW_MS = 80;

/** Small seeded PRNG: the lattice wiring is fixed between reloads, not re-rolled. */
function prng(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashText(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function buildLattice() {
  const positions = new Float32Array(LATTICE * 3);
  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (let node = 0; node < PER_LAYER; node += 1) {
      // Sunflower disc: even spacing without a visible grid.
      const radius = 0.86 * Math.sqrt((node + 0.5) / PER_LAYER);
      const angle = node * 2.39996;
      const offset = (layer * PER_LAYER + node) * 3;
      positions[offset] = LAYER_X[layer];
      positions[offset + 1] = Math.cos(angle) * radius;
      positions[offset + 2] = Math.sin(angle) * radius;
    }
  }
  const random = prng(7);
  const edges: number[] = [];
  const next: number[][] = Array.from({ length: LATTICE }, () => []);
  for (let layer = 0; layer < LAYERS - 1; layer += 1) {
    for (let node = 0; node < PER_LAYER; node += 1) {
      const from = layer * PER_LAYER + node;
      for (let edge = 0; edge < EDGES_PER_NODE; edge += 1) {
        // One near neighbour and one long-range link per node.
        const target = edge === 0
          ? Math.min(PER_LAYER - 1, Math.max(0, node + Math.round((random() - 0.5) * 8)))
          : Math.floor(random() * PER_LAYER);
        const to = (layer + 1) * PER_LAYER + target;
        edges.push(from, to);
        next[from].push(to);
      }
    }
  }
  return { positions, edges: Uint16Array.from(edges), next };
}

// --- point shader: soft discs with per-point size, color and depth fade -------------------------

const POINT_VERTEX = `
attribute float size;
attribute vec3 tint;
varying vec3 vTint;
varying float vFade;
uniform float pixelRatio;
void main() {
  vTint = tint;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFade = clamp(1.0 - (-mv.z - 3.0) / 7.0, 0.15, 1.0);
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
    uniforms: { pixelRatio: { value: pixelRatio } },
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// --- the thread: measured chunks laid out by arrival time --------------------------------------

const THREAD_START = -2.35;
const THREAD_END = 2.35;
const THREAD_RADIUS = 1.18;
const ANCHOR: [number, number, number] = [-2.65, 0, 0];

/** Smallest gap between neighbouring nodes, so a burst reads as compressed, not as one blob. */
const THREAD_MIN_STEP = (THREAD_END - THREAD_START) / MAX_FRAGMENTS;

/**
 * Lays chunks along x by real arrival time. Providers and networks deliver chunks in bursts,
 * which placed many nodes on the same spot; each node now sits at least THREAD_MIN_STEP after
 * the previous one, and the whole thread is rescaled to fit if that pushes it past the end.
 * Order and relative gaps stay true; only zero-length gaps are widened. The helix angle just
 * separates neighbours so they stay legible.
 */
function layoutThread(fragments: readonly { at: number }[], count: number, span: number, out: Float32Array) {
  let previous = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const timeX = THREAD_START + (THREAD_END - THREAD_START) * Math.min(1, fragments[index].at / Math.max(1, span));
    previous = Math.max(timeX, previous + THREAD_MIN_STEP);
    out[index * 3] = previous;
  }
  const scale = previous > THREAD_END ? (THREAD_END - THREAD_START) / (previous - THREAD_START) : 1;
  for (let index = 0; index < count; index += 1) {
    const offset = index * 3;
    const angle = index * 0.62;
    out[offset] = THREAD_START + (out[offset] - THREAD_START) * scale;
    out[offset + 1] = Math.cos(angle) * THREAD_RADIUS;
    out[offset + 2] = Math.sin(angle) * THREAD_RADIUS;
  }
}

/** How long the finished structure lingers before the canvas returns to its idle form. */
const LINGER_MS = 14_000;

type Tip = { x: number; y: number; text: string };

export default function EmotionCanvas({ signal, visual }: { signal: CanvasSignal; visual: CanvasVisual }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const signalRef = useRef(signal);
  const visualRef = useRef(visual);
  const idleTargetsRef = useRef(sampleShape(visual, LATTICE));

  useSyncExternalStore(subscribeTelemetry, telemetryRevision, () => 0);
  // The HUD's elapsed clock has to tick while waiting, when no events arrive to re-render it.
  const [, setTick] = useState(0);
  const live = telemetry.phase === "waiting" || telemetry.phase === "streaming";
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 100);
    return () => window.clearInterval(timer);
  }, [live]);

  useEffect(() => { signalRef.current = signal; }, [signal]);
  useEffect(() => {
    visualRef.current = visual;
    idleTargetsRef.current = sampleShape(visual, LATTICE);
  }, [visual]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setFallback(true); return; }
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" }); }
    catch { setFallback(true); return; }

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x050607, 0);
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x050607, 0.11);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
    const rig = new THREE.Group();
    scene.add(rig);

    // Lattice (illustrative scaffold).
    const lattice = buildLattice();
    const latticePositions = new Float32Array(idleTargetsRef.current);
    const latticeTint = new Float32Array(LATTICE * 3);
    const latticeSize = new Float32Array(LATTICE).fill(0.05);
    const activation = new Float32Array(LATTICE);
    const latticeGeometry = new THREE.BufferGeometry();
    latticeGeometry.setAttribute("position", new THREE.BufferAttribute(latticePositions, 3));
    latticeGeometry.setAttribute("tint", new THREE.BufferAttribute(latticeTint, 3));
    latticeGeometry.setAttribute("size", new THREE.BufferAttribute(latticeSize, 1));
    const latticePointsMaterial = pointMaterial(pixelRatio);
    rig.add(new THREE.Points(latticeGeometry, latticePointsMaterial));

    const edgeCount = lattice.edges.length / 2;
    const edgePositions = new Float32Array(edgeCount * 6);
    const edgeColors = new Float32Array(edgeCount * 6);
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    rig.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

    // Thread (measured): one node per chunk, plus the prompt anchor at index MAX_FRAGMENTS.
    const threadCount = MAX_FRAGMENTS + 1;
    const threadPositions = new Float32Array(threadCount * 3);
    const threadTint = new Float32Array(threadCount * 3);
    const threadSize = new Float32Array(threadCount);
    const threadGeometry = new THREE.BufferGeometry();
    threadGeometry.setAttribute("position", new THREE.BufferAttribute(threadPositions, 3));
    threadGeometry.setAttribute("tint", new THREE.BufferAttribute(threadTint, 3));
    threadGeometry.setAttribute("size", new THREE.BufferAttribute(threadSize, 1));
    // Positions change every frame; a fixed generous bound keeps raycasting valid without recomputes.
    threadGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);
    const threadMaterial = pointMaterial(pixelRatio);
    const threadPoints = new THREE.Points(threadGeometry, threadMaterial);
    rig.add(threadPoints);

    // Lexical links (derived).
    const linkPositions = new Float32Array(MAX_LINKS * 6);
    const linkColors = new Float32Array(MAX_LINKS * 6);
    const linkGeometry = new THREE.BufferGeometry();
    linkGeometry.setAttribute("position", new THREE.BufferAttribute(linkPositions, 3));
    linkGeometry.setAttribute("color", new THREE.BufferAttribute(linkColors, 3));
    linkGeometry.setDrawRange(0, 0);
    const linkMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    rig.add(new THREE.LineSegments(linkGeometry, linkMaterial));

    // Spine (measured order): a faint line through thread nodes in arrival order.
    const spinePositions = new Float32Array(MAX_FRAGMENTS * 3);
    const spineGeometry = new THREE.BufferGeometry();
    spineGeometry.setAttribute("position", new THREE.BufferAttribute(spinePositions, 3));
    spineGeometry.setDrawRange(0, 0);
    const spineMaterial = new THREE.LineBasicMaterial({ color: 0xd8d1c2, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false });
    rig.add(new THREE.Line(spineGeometry, spineMaterial));

    // Pulses: one per PULSE_WINDOW_MS window that received chunks, walking the lattice wiring.
    // Providers stream ~150 chunks a second; a pulse per chunk lit the whole lattice solid.
    type Pulse = { start: number; layer: number; active: number[]; strength: number };
    let pulses: Pulse[] = [];
    let seenFragments = 0;
    let seenStart = -1;
    let flash = 0;
    let windowText = "";
    let windowOpenedAt = 0;

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      const halfAngle = Math.tan((camera.fov * Math.PI) / 360);
      camera.position.z = Math.min(11, Math.max(4.4, 3.1 / (halfAngle * camera.aspect), 1.75 / halfAngle));
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    // Pointer: slow parallax, and hover readout of real chunk data.
    const pointer = new THREE.Vector2(9, 9);
    let pointerX = 0;
    let pointerY = 0;
    let hoverPending = false;
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.09 };
    const onMove = (event: PointerEvent) => {
      const bounds = host.getBoundingClientRect();
      pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
      pointerX = pointer.x;
      pointerY = pointer.y;
      hoverPending = true;
    };
    const onLeave = () => { pointer.set(9, 9); pointerX = 0; pointerY = 0; setTip(null); };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);

    let animation = 0;
    let lastFrame = 0;
    let onScreen = true;
    let hasBeenVisible = false;

    const render = (timestamp: number) => {
      animation = window.requestAnimationFrame(render);
      const dt = lastFrame ? Math.min(0.1, (timestamp - lastFrame) / 1000) : 1 / 60;
      const t = timestamp / 1000;
      const phase = telemetry.phase;
      const sinceEnd = telemetry.endedAt === null ? 0 : performance.now() - (telemetry.startedAt + telemetry.endedAt);
      const showActivity = phase === "waiting" || phase === "streaming"
        || ((phase === "done" || phase === "error" || phase === "aborted") && sinceEnd < LINGER_MS);
      // Nothing moves when idle except the slow breath; halve the frame rate to save power.
      if (!showActivity && timestamp - lastFrame < 32) return;
      lastFrame = timestamp;

      // A new request: forget the previous thread.
      if (telemetry.startedAt !== seenStart) {
        seenStart = telemetry.startedAt;
        seenFragments = 0;
        pulses = [];
        windowText = "";
        threadSize.fill(0);
      }
      // Real chunks only: they collect into the current window, and a window that received
      // anything launches exactly one pulse. No window, no pulse.
      const fragments = telemetry.fragments;
      while (seenFragments < fragments.length) {
        if (!windowText) windowOpenedAt = timestamp;
        windowText += fragments[seenFragments].text;
        seenFragments += 1;
      }
      if (windowText && timestamp - windowOpenedAt >= PULSE_WINDOW_MS) {
        const random = prng(hashText(windowText));
        const strength = Math.min(1, 0.35 + windowText.length / 60);
        const seeds = Array.from({ length: 1 + Math.min(2, windowText.length >> 5) }, () => Math.floor(random() * PER_LAYER));
        pulses.push({ start: timestamp, layer: -1, active: seeds, strength });
        windowText = "";
        flash = strength;
      }

      // Lattice: idle form vs layered structure.
      const targets = showActivity ? lattice.positions : idleTargetsRef.current;
      const ease = 1 - Math.exp(-dt * (showActivity ? 3.2 : 1.6));
      // Once the stream ends, everything fades together: a finished reply must not look active.
      const linger = showActivity && telemetry.endedAt !== null ? Math.max(0, 1 - sinceEnd / LINGER_MS) : 1;
      const fade = (phase === "aborted" ? 0.5 : 1) * linger;
      const decay = Math.exp(-dt / 0.42);
      for (let index = 0; index < LATTICE; index += 1) activation[index] *= decay;
      pulses = pulses.filter((pulse) => {
        const layer = Math.floor((timestamp - pulse.start) / LAYER_STEP_MS);
        while (pulse.layer < layer && pulse.layer < LAYERS - 1) {
          pulse.layer += 1;
          const base = pulse.layer * PER_LAYER;
          const lit = pulse.layer === 0 ? pulse.active.map((node) => base + node) : pulse.active;
          for (const node of lit) activation[node] = Math.max(activation[node], pulse.strength);
          // Propagate along the drawn wiring, capped so a pulse stays a thread, not a flood.
          pulse.active = [...new Set(lit.flatMap((node) => lattice.next[node]))].slice(0, 3);
        }
        return pulse.layer < LAYERS - 1;
      });

      const mood = MOOD_TINT[visualRef.current.mood];
      const waitingBreath = phase === "waiting" ? 0.35 + 0.25 * Math.sin(t * 2.1) : 0;
      const errorShake = phase === "error" ? 0.02 : 0;
      for (let index = 0; index < LATTICE; index += 1) {
        const offset = index * 3;
        for (let axis = 0; axis < 3; axis += 1) {
          latticePositions[offset + axis] += (targets[offset + axis] - latticePositions[offset + axis]) * ease
            + (errorShake ? (Math.random() - 0.5) * errorShake : 0);
        }
        const a = activation[index];
        const base = showActivity ? 0.07 + waitingBreath * 0.06 : 0.42 + 0.06 * Math.sin(t * 0.8 + index * 0.05);
        const color = showActivity ? BONE : mood;
        for (let channel = 0; channel < 3; channel += 1) {
          latticeTint[offset + channel] = (color[channel] * base * (1 - a) + RUST[channel] * a * 1.6 + BONE[channel] * a * 0.35) * fade;
        }
        latticeSize[index] = (showActivity ? 0.045 : 0.05) + a * 0.09;
      }
      latticeGeometry.getAttribute("position").needsUpdate = true;
      latticeGeometry.getAttribute("tint").needsUpdate = true;
      latticeGeometry.getAttribute("size").needsUpdate = true;

      // Lattice wiring: only visible while there is activity.
      const wiring = showActivity ? 1 : 0;
      for (let edge = 0; edge < edgeCount; edge += 1) {
        const from = lattice.edges[edge * 2];
        const to = lattice.edges[edge * 2 + 1];
        const offset = edge * 6;
        for (let axis = 0; axis < 3; axis += 1) {
          edgePositions[offset + axis] = latticePositions[from * 3 + axis];
          edgePositions[offset + 3 + axis] = latticePositions[to * 3 + axis];
        }
        const a = Math.max(activation[from], activation[to]);
        for (let channel = 0; channel < 3; channel += 1) {
          // Unlit wiring sits just above black: ~600 additive lines saturate to white otherwise.
          const value = (BONE[channel] * 0.011 + RUST[channel] * a * a * 0.55) * wiring * fade;
          edgeColors[offset + channel] = value;
          edgeColors[offset + 3 + channel] = value;
        }
      }
      edgeGeometry.getAttribute("position").needsUpdate = true;
      edgeGeometry.getAttribute("color").needsUpdate = true;

      // Thread: real chunks at real arrival times.
      const now = performance.now() - telemetry.startedAt;
      const span = telemetry.endedAt ?? Math.max(1500, now);
      const shown = showActivity ? fragments.length : 0;
      layoutThread(fragments, shown, span, threadPositions);
      for (let index = 0; index < shown; index += 1) {
        const offset = index * 3;
        const age = (now - fragments[index].at) / 1000;
        const fresh = Math.exp(-age * 2.2);
        const length = Math.min(1, fragments[index].text.length / 24);
        for (let channel = 0; channel < 3; channel += 1) {
          threadTint[offset + channel] = (BONE[channel] * (0.32 + 0.3 * length) * (1 - fresh) + RUST[channel] * fresh * 1.4 + BONE[channel] * fresh * 0.5) * fade;
        }
        threadSize[index] = 0.05 + length * 0.07 + fresh * 0.08;
      }
      for (let index = shown; index < MAX_FRAGMENTS; index += 1) threadSize[index] = 0;
      // Prompt anchor: where links back to the user's own words terminate.
      const anchor = MAX_FRAGMENTS * 3;
      threadPositions.set(ANCHOR, anchor);
      const anchorGlow = showActivity ? (0.4 + 0.15 * Math.sin(t * 1.3)) * linger : 0;
      threadTint.set([BONE[0] * anchorGlow, BONE[1] * anchorGlow, BONE[2] * anchorGlow], anchor);
      threadSize[MAX_FRAGMENTS] = showActivity ? 0.16 + 0.02 * telemetry.sourceCount : 0;
      threadGeometry.getAttribute("position").needsUpdate = true;
      threadGeometry.getAttribute("tint").needsUpdate = true;
      threadGeometry.getAttribute("size").needsUpdate = true;

      // Lexical links between thread nodes.
      const links = showActivity ? telemetry.links : [];
      for (let index = 0; index < links.length; index += 1) {
        const link = links[index];
        const fromOffset = link.from === -1 ? anchor : link.from * 3;
        const toOffset = link.to * 3;
        const offset = index * 6;
        for (let axis = 0; axis < 3; axis += 1) {
          linkPositions[offset + axis] = threadPositions[fromOffset + axis];
          linkPositions[offset + 3 + axis] = threadPositions[toOffset + axis];
        }
        const fresh = Math.exp(-((now - fragments[link.to].at) / 1000) * 1.5);
        const strength = (0.09 + fresh * 0.55) * fade;
        const color = link.from === -1 ? BONE : RUST;
        for (let channel = 0; channel < 3; channel += 1) {
          linkColors[offset + channel] = color[channel] * strength;
          linkColors[offset + 3 + channel] = color[channel] * strength;
        }
      }
      linkGeometry.setDrawRange(0, links.length * 2);
      spinePositions.set(threadPositions.subarray(0, shown * 3));
      spineGeometry.setDrawRange(0, shown);
      spineGeometry.getAttribute("position").needsUpdate = true;
      spineMaterial.opacity = 0.16 * fade;
      linkGeometry.getAttribute("position").needsUpdate = true;
      linkGeometry.getAttribute("color").needsUpdate = true;

      // Camera: slow drift plus pointer parallax; a brief recoil when a chunk lands.
      flash *= Math.exp(-dt * 6);
      rig.rotation.y += ((showActivity ? 0.32 : 0) + pointerX * 0.35 + Math.sin(t * 0.11) * 0.18 - rig.rotation.y) * (1 - Math.exp(-dt * 1.4));
      rig.rotation.x += (pointerY * -0.2 + Math.sin(t * 0.09) * 0.06 - rig.rotation.x) * (1 - Math.exp(-dt * 1.4));
      rig.position.z = flash * 0.05;

      // Hover readout: only for thread nodes, which carry real data.
      if (hoverPending) {
        hoverPending = false;
        raycaster.setFromCamera(pointer, camera);
        const hit = shown ? raycaster.intersectObject(threadPoints).find((item) => item.index !== undefined && item.index < shown) : undefined;
        if (hit && hit.index !== undefined) {
          const fragment = fragments[hit.index];
          const projected = new THREE.Vector3(threadPositions[hit.index * 3], threadPositions[hit.index * 3 + 1], threadPositions[hit.index * 3 + 2])
            .applyMatrix4(rig.matrixWorld).project(camera);
          const bounds = host.getBoundingClientRect();
          setTip({
            x: (projected.x * 0.5 + 0.5) * bounds.width,
            y: (-projected.y * 0.5 + 0.5) * bounds.height,
            text: `#${hit.index + 1} · +${Math.round(fragment.at)}ms · gap ${Math.round(fragment.gap)}ms · ${JSON.stringify(fragment.text).slice(0, 48)}`,
          });
        } else {
          setTip(null);
        }
      }

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
      for (const geometry of [latticeGeometry, edgeGeometry, threadGeometry, linkGeometry, spineGeometry]) geometry.dispose();
      for (const material of [latticePointsMaterial, edgeMaterial, threadMaterial, linkMaterial, spineMaterial]) material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const stats = streamStats();
  const phase = telemetry.phase;
  const recent = telemetry.fragments.slice(-6);
  const ms = (value: number | null) => (value === null ? "—" : `${Math.round(value)}ms`);
  const phaseLabel = phase === "idle" ? SIGNAL_LABELS[signal]
    : phase === "waiting" ? "AWAITING FIRST CHUNK"
      : phase === "streaming" ? "RECEIVING"
        : phase === "done" ? (telemetry.truncated ? "COMPLETE · TRUNCATED" : "COMPLETE")
          : phase === "aborted" ? "SEVERED" : "FAILED";

  return <section
    className={`emotion-canvas activity-canvas signal-${signal} phase-${phase}`}
    aria-label={`Response stream visualization: ${phaseLabel}. ${stats.chunks} chunks received. Shows measured stream timing, not model internals.`}
  >
    {fallback && <div className="canvas-fallback" aria-hidden="true"><span>✧</span><i/><i/><i/><i/><i/><i/><i/><i/></div>}
    <div ref={hostRef} className="three-host" aria-hidden="true" />

    <div className="activity-hud" aria-hidden="true">
      <div className="activity-hud-phase">{phaseLabel}</div>
      {phase !== "idle" && <dl>
        <dt>PROVIDER</dt><dd><b>M</b>{telemetry.provider || "—"}</dd>
        <dt>ELAPSED</dt><dd><b>M</b>{ms(stats.elapsedMs)}</dd>
        <dt>FIRST CHUNK</dt><dd><b>M</b>{ms(stats.firstChunkMs)}</dd>
        <dt>CHUNKS</dt><dd><b>M</b>{stats.chunks}</dd>
        <dt>MEDIAN GAP</dt><dd><b>D</b>{ms(stats.medianGapMs)}</dd>
        <dt>CHARS / S</dt><dd><b>D</b>{stats.charsPerSecond === null ? "—" : Math.round(stats.charsPerSecond)}</dd>
        <dt>SEARCH</dt><dd><b>M</b>{telemetry.searchStatus ? `${telemetry.searchStatus} · ${telemetry.sourceCount} src` : "—"}</dd>
        <dt>LEXICAL LINKS</dt><dd><b>D</b>{stats.links} <span>({stats.promptLinks} to prompt)</span></dd>
      </dl>}
    </div>

    {phase !== "idle" && recent.length > 0 && <div className="activity-ticker" aria-hidden="true">
      {recent.map((fragment, index) => (
        <span key={telemetry.fragments.length - recent.length + index} style={{ opacity: 0.25 + (0.75 * (index + 1)) / recent.length }}>
          {fragment.text.replace(/\n/g, " ⏎ ")}
        </span>
      ))}
    </div>}

    {tip && <div className="activity-tip" style={{ left: tip.x, top: tip.y }} aria-hidden="true">{tip.text}</div>}

    <p className="activity-legend" aria-hidden="true">
      <b>M</b> measured stream · <b>D</b> derived from it · lattice illustrative, each pulse = chunks received in 80ms · lines = repeated words, not attention · no model internals are exposed
    </p>
  </section>;
}
