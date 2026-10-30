"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as THREE from "three";
import type { MoodName, MoodState } from "@/lib/mood";
import { FORM_POINTS, type PointCloud } from "@/lib/visualize";
import { state as telemetry, subscribeTelemetry, telemetryRevision } from "@/lib/stream-telemetry";

export type CanvasSignal = "idle" | "composing" | "generating" | "responding" | "interrupted";

/** A /visualize result shown on the canvas: loading (particles swirl), ready, or failed. */
export type CanvasForm = { key: string; title: string; status: "loading" | "ready" | "error"; cloud?: PointCloud };
const FORM_COUNT = FORM_POINTS;

/**
 * FREYA's presence: a particle body that shows her simulated inner state.
 *
 * Every behaviour is driven by a real signal, never by chance:
 *   MOOD       the app's mood state (lib/mood): its name sets the body's shape and motion,
 *              energy sets breathing speed and size, warmth sets the colour temperature.
 *   LISTENING  the user is typing: the body leans towards the composer and brightens.
 *   THINKING   a reply was requested and nothing has arrived yet: it draws in and orbits.
 *   SPEAKING   streamed chunks arriving: each 80 ms window of real chunks launches exactly one
 *              ripple from the front of the body. No window, no ripple.
 *   ATTENTION  the pointer: the body turns slightly towards it.
 * The mood is a character simulation the app keeps; this shows that simulation, not feelings or
 * model internals.
 */

const PRESENCE = 900;
const RADIUS = 1.05;
const RIPPLE_WINDOW_MS = 80;

/** Each mood's body: how it is shaped and how it moves. Values are small on purpose. */
type MoodStyle = { scale: number; squash: number; sink: number; wave: number; waveSpeed: number; jag: number; drift: number; lean: number; glow: number; tint: [number, number, number] };
const MOOD_STYLE: Record<MoodName, MoodStyle> = {
  playful: { scale: 1, squash: 1, sink: 0, wave: 0.08, waveSpeed: 2.6, jag: 0, drift: 0.02, lean: 0, glow: 1, tint: [0.92, 0.7, 0.52] },
  warm: { scale: 1.05, squash: 1, sink: 0, wave: 0.02, waveSpeed: 0.8, jag: 0, drift: 0, lean: 0, glow: 1, tint: [0.95, 0.66, 0.5] },
  curious: { scale: 1, squash: 1, sink: 0, wave: 0.03, waveSpeed: 1.4, jag: 0, drift: 0.01, lean: 0.18, glow: 0.95, tint: [0.72, 0.78, 0.82] },
  content: { scale: 1, squash: 0.97, sink: 0, wave: 0.015, waveSpeed: 0.6, jag: 0, drift: 0, lean: 0, glow: 0.85, tint: [0.8, 0.76, 0.66] },
  excited: { scale: 1.12, squash: 1.04, sink: 0, wave: 0.06, waveSpeed: 4, jag: 0.02, drift: 0.04, lean: 0.06, glow: 1.15, tint: [0.98, 0.78, 0.5] },
  bored: { scale: 0.9, squash: 0.78, sink: -0.14, wave: 0.01, waveSpeed: 0.3, jag: 0, drift: 0, lean: 0, glow: 0.55, tint: [0.62, 0.64, 0.64] },
  tired: { scale: 0.88, squash: 0.74, sink: -0.2, wave: 0.008, waveSpeed: 0.25, jag: 0, drift: 0, lean: 0, glow: 0.45, tint: [0.58, 0.6, 0.68] },
  restless: { scale: 0.98, squash: 1, sink: 0, wave: 0.04, waveSpeed: 2.2, jag: 0.015, drift: 0.07, lean: 0, glow: 0.9, tint: [0.78, 0.72, 0.7] },
  melancholy: { scale: 0.94, squash: 0.92, sink: -0.1, wave: 0.015, waveSpeed: 0.4, jag: 0, drift: 0, lean: 0, glow: 0.6, tint: [0.5, 0.58, 0.74] },
  irritated: { scale: 0.96, squash: 1, sink: 0, wave: 0.01, waveSpeed: 1, jag: 0.07, drift: 0.01, lean: 0, glow: 0.85, tint: [0.84, 0.46, 0.4] },
  sulking: { scale: 0.78, squash: 0.95, sink: -0.06, wave: 0.005, waveSpeed: 0.3, jag: 0.02, drift: 0, lean: 0, glow: 0.5, tint: [0.62, 0.52, 0.58] },
};

/** Even directions on a sphere (Fibonacci lattice): the body's resting surface. */
function sphereDirections(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < count; index += 1) {
    const y = 1 - (index / (count - 1)) * 2;
    const ring = Math.sqrt(1 - y * y);
    const angle = index * golden;
    out.set([Math.cos(angle) * ring, y, Math.sin(angle) * ring], index * 3);
  }
  return out;
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

/** What the presence is doing, from real signals only. */
type Activity = "idle" | "listening" | "thinking" | "speaking";
const ACTIVITY_LABEL: Record<Activity, string> = { idle: "HERE", listening: "LISTENING", thinking: "THINKING", speaking: "SPEAKING" };

function activityOf(signal: CanvasSignal): Activity {
  if (telemetry.phase === "streaming") return "speaking";
  if (telemetry.phase === "waiting" || signal === "generating") return "thinking";
  if (signal === "composing") return "listening";
  return "idle";
}

export default function EmotionCanvas({ signal, mood, form = null, onClearForm }: { signal: CanvasSignal; mood: MoodState; form?: CanvasForm | null; onClearForm?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  const signalRef = useRef(signal);
  const moodRef = useRef(mood);
  const formRef = useRef<CanvasForm | null>(form);

  // Re-render on stream events so the activity label stays true.
  useSyncExternalStore(subscribeTelemetry, telemetryRevision, () => 0);
  useEffect(() => { signalRef.current = signal; }, [signal]);
  useEffect(() => { moodRef.current = mood; }, [mood]);
  useEffect(() => { formRef.current = form; }, [form]);

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

    // Presence: one point per direction, displaced every frame by mood and activity.
    const directions = sphereDirections(PRESENCE);
    const presencePositions = new Float32Array(directions);
    const presenceTint = new Float32Array(PRESENCE * 3);
    const presenceSize = new Float32Array(PRESENCE).fill(0.05);
    const presenceGeometry = new THREE.BufferGeometry();
    presenceGeometry.setAttribute("position", new THREE.BufferAttribute(presencePositions, 3));
    presenceGeometry.setAttribute("tint", new THREE.BufferAttribute(presenceTint, 3));
    presenceGeometry.setAttribute("size", new THREE.BufferAttribute(presenceSize, 1));
    presenceGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 3);
    const presenceMaterial = pointMaterial(pixelRatio);
    rig.add(new THREE.Points(presenceGeometry, presenceMaterial));

    // Visualised form (/visualize): its own point cloud, spinning slowly so it reads as 3D.
    const formPositions = new Float32Array(FORM_COUNT * 3);
    const formTint = new Float32Array(FORM_COUNT * 3);
    const formSize = new Float32Array(FORM_COUNT);
    const formColors = new Float32Array(FORM_COUNT * 3).fill(0.8);
    const swirl = swirlTargets(FORM_COUNT);
    let formTargets: Float32Array = swirl;
    let formKey = "";
    let formStatus = "";
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

    // Ripples: launched only by real streamed chunks (one per 80 ms window that received any).
    type Ripple = { start: number; strength: number };
    let ripples: Ripple[] = [];
    let seenFragments = 0;
    let seenStart = -1;
    let windowChars = 0;
    let windowOpenedAt = 0;
    // Smoothed state, so moods and activities blend instead of jumping.
    const style = { ...MOOD_STYLE.curious };
    let energy = 0.7;
    let warmth = 0.7;
    let listen = 0;
    let think = 0;
    let shiver = 0;

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

    let pointerX = 0;
    let pointerY = 0;
    const onMove = (event: PointerEvent) => {
      const bounds = host.getBoundingClientRect();
      pointerX = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointerY = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    };
    const onLeave = () => { pointerX = 0; pointerY = 0; };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);

    let animation = 0;
    let lastFrame = 0;
    let onScreen = true;
    let hasBeenVisible = false;

    const render = (timestamp: number) => {
      animation = window.requestAnimationFrame(render);
      const activity = activityOf(signalRef.current);
      // A resting presence only breathes; half the frame rate saves power.
      if (activity === "idle" && !formRef.current && timestamp - lastFrame < 32) return;
      const dt = lastFrame ? Math.min(0.1, (timestamp - lastFrame) / 1000) : 1 / 60;
      lastFrame = timestamp;
      const t = timestamp / 1000;
      const blend = 1 - Math.exp(-dt * 1.6);

      // Mood: ease towards the current mood's body, energy and warmth.
      const currentMood = moodRef.current;
      const target = MOOD_STYLE[currentMood.name] ?? MOOD_STYLE.curious;
      for (const key of Object.keys(target) as (keyof MoodStyle)[]) {
        if (key === "tint") style.tint = style.tint.map((value, channel) => value + (target.tint[channel] - value) * blend) as MoodStyle["tint"];
        else (style[key] as number) += ((target[key] as number) - (style[key] as number)) * blend;
      }
      energy += (currentMood.energy - energy) * blend;
      warmth += (currentMood.warmth - warmth) * blend;
      listen += ((activity === "listening" ? 1 : 0) - listen) * (1 - Math.exp(-dt * 4));
      think += ((activity === "thinking" ? 1 : 0) - think) * (1 - Math.exp(-dt * 3));
      shiver *= Math.exp(-dt * 3);
      if (telemetry.phase === "error" || telemetry.phase === "aborted" || signalRef.current === "interrupted") shiver = Math.max(shiver, telemetry.endedAt !== null && performance.now() - (telemetry.startedAt + telemetry.endedAt) < 600 ? 1 : 0);

      // Speaking: real chunks, collected into windows; each window launches one ripple.
      if (telemetry.startedAt !== seenStart) { seenStart = telemetry.startedAt; seenFragments = 0; windowChars = 0; }
      while (seenFragments < telemetry.fragments.length) {
        if (!windowChars) windowOpenedAt = timestamp;
        windowChars += telemetry.fragments[seenFragments].text.length || 1;
        seenFragments += 1;
      }
      if (windowChars && timestamp - windowOpenedAt >= RIPPLE_WINDOW_MS) {
        ripples.push({ start: t, strength: Math.min(1, 0.35 + windowChars / 60) });
        windowChars = 0;
      }
      ripples = ripples.filter((ripple) => t - ripple.start < 1.6).slice(-12);

      // Form on stage: the presence steps back into a dim halo.
      const shownForm = formRef.current;
      const formActive = Boolean(shownForm && shownForm.status !== "error");
      formLevel += ((formActive ? 1 : 0) - formLevel) * (1 - Math.exp(-dt * 2.4));

      const breathRate = 0.45 + energy * 1.1;
      const breath = 1 + (0.025 + energy * 0.035) * Math.sin(t * breathRate);
      const radius = RADIUS * style.scale * (0.62 + 0.38 * energy) * breath * (1 - 0.18 * think) * (1 - 0.35 * formLevel);
      const warmTint: [number, number, number] = [0.98, 0.7, 0.5];
      const coolTint: [number, number, number] = [0.55, 0.64, 0.76];
      const temperature = style.tint.map((value, channel) => value * 0.6 + (coolTint[channel] + (warmTint[channel] - coolTint[channel]) * warmth) * 0.4);
      const brightness = (0.6 + 0.55 * style.glow + 0.35 * listen + 0.25 * think) * (1 - 0.7 * formLevel);
      for (let index = 0; index < PRESENCE; index += 1) {
        const offset = index * 3;
        const dx = directions[offset];
        const dy = directions[offset + 1];
        const dz = directions[offset + 2];
        const longitude = Math.atan2(dz, dx);
        let r = radius
          * (1 + style.wave * Math.sin(dy * 5 + t * style.waveSpeed))
          * (1 + style.jag * Math.sign(Math.sin(longitude * 9 + dy * 7 + t * 1.3)))
          * (1 + style.drift * Math.sin(index * 12.9898 + t * 0.9));
        // Speaking: ripples travel from the front (+z, towards the viewer) over the surface.
        let lit = 0;
        for (const ripple of ripples) {
          const travelled = (t - ripple.start) * 2.2;
          const distance = Math.acos(Math.max(-1, Math.min(1, dz)));
          const band = Math.exp(-((distance - travelled) ** 2) * 10) * (1 - (t - ripple.start) / 1.6);
          r *= 1 + 0.07 * ripple.strength * band;
          lit = Math.max(lit, band * ripple.strength);
        }
        if (shiver > 0.01) r *= 1 + 0.03 * shiver * Math.sin(index * 7.1 + t * 40);
        // Thinking: rings orbit around the vertical axis at different speeds.
        const spin = think * t * (0.6 + Math.abs(dy) * 1.4);
        const x = dx * Math.cos(spin) - dz * Math.sin(spin);
        const z = dx * Math.sin(spin) + dz * Math.cos(spin);
        presencePositions[offset] = x * r;
        // Low moods sag: the lower half settles more than the top.
        presencePositions[offset + 1] = dy * r * style.squash + style.sink * (1 - dy) * 0.5 + listen * 0.12;
        presencePositions[offset + 2] = z * r;
        const shade = brightness * (0.75 + 0.25 * Math.sin(index * 3.7 + t * 0.7)) + lit * 0.5;
        for (let channel = 0; channel < 3; channel += 1) presenceTint[offset + channel] = temperature[channel] * shade;
        presenceSize[index] = 0.058 + lit * 0.06 + listen * 0.01;
      }
      presenceGeometry.getAttribute("position").needsUpdate = true;
      presenceGeometry.getAttribute("tint").needsUpdate = true;
      presenceGeometry.getAttribute("size").needsUpdate = true;

      // Visualised form: swirl while composing, settle into the shape, fade out when cleared.
      const nextKey = shownForm ? `${shownForm.key}:${shownForm.status}` : "";
      if (nextKey !== formKey) {
        formKey = nextKey;
        formStatus = shownForm?.status ?? "";
        if (shownForm?.status === "ready" && shownForm.cloud) {
          formTargets = shownForm.cloud.positions;
          formColors.set(shownForm.cloud.colors.subarray(0, FORM_COUNT * 3));
        } else if (shownForm?.status === "loading") {
          formTargets = swirl;
          formColors.fill(0.78);
        }
      }
      // Hidden, not just black: colourless points still write alpha, leaving a dark outline.
      formGroup.visible = formLevel > 0.002;
      if (formGroup.visible) {
        const settle = 1 - Math.exp(-dt * (formStatus === "loading" ? 1.4 : 2.2));
        const glow = formStatus === "loading" ? 0.35 + 0.15 * Math.sin(t * 3) : 0.95;
        for (let index = 0; index < FORM_COUNT * 3; index += 1) {
          formPositions[index] += (formTargets[index] - formPositions[index]) * settle;
          formTint[index] = formColors[index] * glow * formLevel;
        }
        formSize.fill((formStatus === "loading" ? 0.03 : 0.038) * Math.min(1, formLevel * 1.4));
        formGroup.rotation.y += dt * (formStatus === "loading" ? 1.2 : 0.32);
        formGeometry.getAttribute("position").needsUpdate = true;
        formGeometry.getAttribute("tint").needsUpdate = true;
        formGeometry.getAttribute("size").needsUpdate = true;
      }

      // Attention: the body turns towards the pointer; curious moods lean in further.
      const reach = 0.35 + style.lean;
      rig.rotation.y += (pointerX * reach + Math.sin(t * 0.11) * 0.12 - rig.rotation.y) * (1 - Math.exp(-dt * 1.4));
      rig.rotation.x += (pointerY * -0.2 - listen * 0.18 + Math.sin(t * 0.09) * 0.05 - rig.rotation.x) * (1 - Math.exp(-dt * 1.4));
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
      for (const geometry of [presenceGeometry, formGeometry]) geometry.dispose();
      for (const material of [presenceMaterial, formMaterial]) material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  const activity = activityOf(signal);
  return <section
    className={`emotion-canvas presence-canvas signal-${signal} activity-${activity} mood-${mood.name}`}
    aria-label={`FREYA's presence: ${ACTIVITY_LABEL[activity].toLowerCase()}, mood ${mood.name}. Shows the app's simulated mood and conversation state.`}
  >
    {fallback && <div className="canvas-fallback" aria-hidden="true"><span>✧</span><i/><i/><i/><i/><i/><i/><i/><i/></div>}
    <div ref={hostRef} className="three-host" aria-hidden="true" />
    <div className="presence-status" aria-hidden="true">{ACTIVITY_LABEL[activity]} · {mood.name.toUpperCase()}</div>
    {form && <div className={`form-caption form-${form.status}`} role="status" aria-live="polite">
      <span>{form.status === "loading" ? `Composing · ${form.title}…` : form.status === "error" ? `Couldn't visualise ${form.title}` : `${form.title}${fallback ? " · 3D view needs motion enabled" : ""}`}</span>
      {form.status !== "loading" && onClearForm && <button type="button" onClick={onClearForm} aria-label="Clear the visualisation">Clear</button>}
    </div>}
  </section>;
}
