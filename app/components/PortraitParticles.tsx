"use client";

import portraitAsset from "../static/freya.png";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import * as THREE from "three";
import { captionRevision, getCaption, mouthOpening, speechEmphasis, subscribeCaption, tickCaption } from "@/lib/mouth-drive";

/** Width of the portrait plane in world units. */
const PLANE_SIZE = 3.5;
/** Mesh resolution. 192 segments is ~37k vertices: enough relief without stressing the GPU. */
const SEGMENTS = 192;
/** Height-map resolution used to displace the mesh. */
const HEIGHT_SAMPLES = 200;
/** How far the brightest pixel stands proud of the darkest, in world units. */
const RELIEF_DEPTH = 0.62;
/** Radius, in world units, of the pointer disturbance. */
const INFLUENCE_RADIUS = 0.6;

/**
 * Feature anchors in normalised texture space, measured off the supplied portrait by
 * sampling its luminance (both pupils and the lip line are the darkest points inside their
 * expected bands). They drive the glance and lip motion below.
 *
 * This is a fixed measurement of one asset, not face tracking: swapping the portrait means
 * re-measuring. Nothing here identifies anyone or infers anything about a person.
 */
// Re-measured in square-crop space (crop x offset 154px, side 369px). The mouth anchor used to
// sit at v=0.520, which is the nostril shadow (y≈190px), so speech warped the nose. The lip
// line is the darkest row of the mouth band, y=219px, dark from x=309 to x=370.
const LANDMARKS = {
  leftEye: { u: 0.374, v: 0.363 },
  rightEye: { u: 0.607, v: 0.359 },
  mouth: { u: 0.503, v: 0.594 },
};
const EYE_RADIUS = 0.055;
/** Half the lip line's width (61px / 2 / 369), plus a little so the corners taper. */
const MOUTH_HALF_WIDTH = 0.092;
/** How far above / below the lip line the lips' texture is carried when they part. */
const UPPER_LIP_REACH = 0.034;
const LOWER_LIP_REACH = 0.07;
/** Fully open, the lips part by about 3px (upper) and 9px (lower) at the centre. */
const UPPER_LIP_TRAVEL = 0.008;
const LOWER_LIP_TRAVEL = 0.024;

/**
 * Secondary regions derived from the measured anchors. A face reads as expressive mostly
 * above the mouth: brows carry most of it, cheeks and the jaw carry the rest. Moving lips
 * alone looks like a puppet, which is why these exist.
 */
// Measured, not guessed: scanning up each eye column, the dark brow band bottoms out at a
// rise of 0.050-0.055. At 0.085 the region sat on forehead skin and moved nothing.
const BROW_RISE = 0.053;
const BROW_RADIUS_X = 0.075;
const BROW_RADIUS_Y = 0.032;
/** Mouth corners, where a smile pulls from. */
const CORNER_OFFSET = 0.083;
const CORNER_RADIUS = 0.045;
/** The jaw/chin mass below the lip line, which swings with a wide vowel. */
const JAW_DROP = 0.085;
const JAW_RADIUS_X = 0.125;
const JAW_RADIUS_Y = 0.075;

function meshSegments() {
  const cores = navigator.hardwareConcurrency || 4;
  if (window.innerWidth < 760) return 96;
  return cores <= 4 ? 128 : SEGMENTS;
}

/** Smooth falloff, 1 at the centre of the region and 0 at its edge. */
function falloff(distance: number) {
  if (distance >= 1) return 0;
  const t = 1 - distance;
  return t * t * (3 - 2 * t);
}

export default function PortraitParticles() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  const [disturbed, setDisturbed] = useState(false);
  // The caption is pushed from the speech layer, so it re-renders only on word boundaries.
  useSyncExternalStore(subscribeCaption, captionRevision, () => 0);
  const caption = getCaption();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setFallback(true);
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    } catch {
      setFallback(true);
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    camera.position.z = 5.5;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    renderer.setClearColor(0x05090b, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    host.appendChild(renderer.domElement);

    const field = new THREE.Group();
    scene.add(field);

    // Coloured lighting: a warm key from the left, a cool rim from the right. The relief is
    // what makes these read, and they are what lifts the portrait out of flat greyscale.
    scene.add(new THREE.AmbientLight(0x6b7f8a, 1.05));
    const key = new THREE.DirectionalLight(0xffb98a, 1.45);
    key.position.set(-2.2, 1.6, 3.2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x74b4ff, 1.15);
    rim.position.set(2.6, -0.6, 1.8);
    scene.add(rim);
    const bounce = new THREE.PointLight(0xc98cff, 0.75, 14);
    bounce.position.set(0, -1.8, 2.4);
    scene.add(bounce);

    let geometry: THREE.PlaneGeometry | undefined;
    let material: THREE.MeshStandardMaterial | undefined;
    let texture: THREE.Texture | undefined;
    let basePositions: Float32Array | undefined;
    let baseUvs: Float32Array | undefined;
    let vertexCount = 0;

    let animationFrame = 0;
    let disposed = false;
    let onScreen = true;
    let lastTimestamp = 0;

    let pointerWorldX = 0;
    let pointerWorldY = 0;
    let pointerActive = false;
    let ripple = 0;
    let halfHeight = 1;
    let halfWidth = 1;

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      renderer.setSize(bounds.width, bounds.height, false);
      camera.aspect = bounds.width / bounds.height;
      camera.updateProjectionMatrix();
      halfHeight = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
      halfWidth = halfHeight * camera.aspect;
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const onPointerMove = (event: PointerEvent) => {
      const bounds = host.getBoundingClientRect();
      pointerWorldX = ((event.clientX - bounds.left) / Math.max(bounds.width, 1) - 0.5) * 2 * halfWidth;
      pointerWorldY = (0.5 - (event.clientY - bounds.top) / Math.max(bounds.height, 1)) * 2 * halfHeight;
      pointerActive = true;
      setDisturbed(true);
    };
    const onPointerLeave = () => { pointerActive = false; setDisturbed(false); };
    const onPointerDown = (event: PointerEvent) => { onPointerMove(event); ripple = 1; };
    host.addEventListener("pointermove", onPointerMove, { passive: true });
    host.addEventListener("pointerdown", onPointerDown, { passive: true });
    host.addEventListener("pointerleave", onPointerLeave);
    host.addEventListener("pointercancel", onPointerLeave);

    const image = document.createElement("img");
    image.decoding = "async";
    image.onload = () => {
      if (disposed) return;
      try {
        const sampleCanvas = document.createElement("canvas");
        sampleCanvas.width = HEIGHT_SAMPLES;
        sampleCanvas.height = HEIGHT_SAMPLES;
        const context = sampleCanvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Canvas image sampling is unavailable.");

        // Center-crop the supplied landscape portrait to a square, as the texture does.
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        const sourceX = (image.naturalWidth - side) / 2;
        const sourceY = (image.naturalHeight - side) / 2;
        context.drawImage(image, sourceX, sourceY, side, side, 0, 0, HEIGHT_SAMPLES, HEIGHT_SAMPLES);
        const pixels = context.getImageData(0, 0, HEIGHT_SAMPLES, HEIGHT_SAMPLES).data;

        // Luminance height map, then a box blur. Unsmoothed photo noise turns into spikes
        // that shred the normals and make the relief look like crumpled foil.
        const raw = new Float32Array(HEIGHT_SAMPLES * HEIGHT_SAMPLES);
        for (let i = 0; i < raw.length; i += 1) {
          const p = i * 4;
          raw[i] = (pixels[p] * 0.2126 + pixels[p + 1] * 0.7152 + pixels[p + 2] * 0.0722) / 255;
        }
        const height = new Float32Array(raw.length);
        const R = 2;
        for (let y = 0; y < HEIGHT_SAMPLES; y += 1) {
          for (let x = 0; x < HEIGHT_SAMPLES; x += 1) {
            let total = 0;
            let count = 0;
            for (let dy = -R; dy <= R; dy += 1) {
              const yy = y + dy;
              if (yy < 0 || yy >= HEIGHT_SAMPLES) continue;
              for (let dx = -R; dx <= R; dx += 1) {
                const xx = x + dx;
                if (xx < 0 || xx >= HEIGHT_SAMPLES) continue;
                total += raw[yy * HEIGHT_SAMPLES + xx];
                count += 1;
              }
            }
            height[y * HEIGHT_SAMPLES + x] = total / count;
          }
        }

        const segments = meshSegments();
        geometry = new THREE.PlaneGeometry(PLANE_SIZE, PLANE_SIZE, segments, segments);
        const position = geometry.getAttribute("position") as THREE.BufferAttribute;
        const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
        vertexCount = position.count;
        for (let i = 0; i < vertexCount; i += 1) {
          const u = uv.getX(i);
          const v = uv.getY(i);
          const hx = Math.min(HEIGHT_SAMPLES - 1, Math.max(0, Math.round(u * (HEIGHT_SAMPLES - 1))));
          // Texture V runs bottom-up; the height map rows run top-down.
          const hy = Math.min(HEIGHT_SAMPLES - 1, Math.max(0, Math.round((1 - v) * (HEIGHT_SAMPLES - 1))));
          position.setZ(i, (height[hy * HEIGHT_SAMPLES + hx] - 0.42) * RELIEF_DEPTH);
        }
        geometry.computeVertexNormals();
        basePositions = Float32Array.from(position.array as Float32Array);
        baseUvs = Float32Array.from(uv.array as Float32Array);
        // Per-vertex shade, white everywhere except the open mouth, which it darkens.
        geometry.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(vertexCount * 3).fill(1), 3));

        texture = new THREE.Texture(image);
        texture.colorSpace = THREE.SRGBColorSpace;
        // Match the square center-crop the height map used.
        texture.repeat.set(side / image.naturalWidth, side / image.naturalHeight);
        texture.offset.set(sourceX / image.naturalWidth, sourceY / image.naturalHeight);
        texture.needsUpdate = true;

        material = new THREE.MeshStandardMaterial({
          map: texture,
          roughness: 0.74,
          metalness: 0.12,
          // A faint self-glow keeps the shadow side from crushing to black.
          emissive: new THREE.Color(0x121a20),
          emissiveMap: texture,
          emissiveIntensity: 0.4,
          vertexColors: true,
          side: THREE.FrontSide,
        });

        field.add(new THREE.Mesh(geometry, material));
        setFallback(false);
      } catch {
        setFailed(true);
        setFallback(true);
      }
    };
    image.onerror = () => {
      if (!disposed) { setFailed(true); setFallback(true); }
    };
    image.crossOrigin = "anonymous";
    image.src = portraitAsset.src;

    // Glance targets: she looks around, holds, then moves on.
    let glanceX = 0;
    let glanceY = 0;
    let glanceTargetX = 0;
    let glanceTargetY = 0;
    let nextGlance = 0;
    // Blink schedule. Real blinks are irregular and sometimes double, never metronomic.
    let blinkStart = 2 + Math.random() * 3;
    let blinkDuration = 0.14;
    let doubleBlink = false;
    let idleLip = 0;
    let lipOpen = 0;

    /**
     * Expression state. A face is expressive above the mouth more than at it, so these drive
     * brows, lids and cheeks; the mouth only supplies the speech envelope on top.
     * Each value eases toward a target so nothing snaps between poses.
     */
    let browRaise = 0;        // -1 furrowed, +1 lifted
    let browTarget = 0;
    let smile = 0;            // 0 neutral, 1 amused
    let smileTarget = 0;
    let squint = 0;           // lids narrowing, which is what makes a smile reach the eyes
    let jaw = 0;              // smoothed mouth opening, so the jaw lags the lips slightly
    let nextMood = 0;
    let headTilt = 0;
    let headTiltTarget = 0;

    const render = (timestamp: number) => {
      if (disposed) return;
      const time = timestamp / 1000;
      const delta = lastTimestamp ? Math.min(90, timestamp - lastTimestamp) : 16.7;
      lastTimestamp = timestamp;
      const step = Math.min(2.2, Math.max(0.35, delta / 16.7));

      if (geometry && basePositions && baseUvs) {
        const position = geometry.getAttribute("position") as THREE.BufferAttribute;
        const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
        const positions = position.array as Float32Array;
        const uvs = uv.array as Float32Array;
        const color = geometry.getAttribute("color") as THREE.BufferAttribute;
        const colors = color.array as Float32Array;

        // Blink: closes faster than it opens, which is what makes a blink read as a blink.
        let blink = 0;
        const sinceBlink = time - blinkStart;
        if (sinceBlink >= 0 && sinceBlink <= blinkDuration) {
          const t = sinceBlink / blinkDuration;
          const shape = t < 0.38 ? t / 0.38 : 1 - (t - 0.38) / 0.62;
          const clamped = Math.max(0, Math.min(1, shape));
          blink = clamped * clamped * (3 - 2 * clamped);
        } else if (sinceBlink > blinkDuration) {
          if (doubleBlink) {
            doubleBlink = false;
            blinkStart = time + 0.1;
            blinkDuration = 0.12;
          } else {
            // Mostly 2-7s apart, occasionally a quick double.
            blinkStart = time + 2 + Math.random() * 5;
            blinkDuration = 0.12 + Math.random() * 0.06;
            doubleBlink = Math.random() < 0.22;
          }
        }

        // Lips follow the spoken-word envelope; idle breathing takes over between utterances.
        tickCaption(timestamp);
        const spoken = mouthOpening(timestamp);
        const emphasis = speechEmphasis();
        // The photo's lips are closed, so at rest they barely part with the breath.
        idleLip += ((Math.sin(time * 0.8) * 0.5 + 0.5) * 0.04 - idleLip) * 0.05 * step;
        // Eased toward the envelope: lips that jump frame to frame read as flicker, not speech.
        lipOpen += (Math.max(spoken, idleLip) - lipOpen) * Math.min(1, 0.45 * step);
        const lip = lipOpen;
        // The jaw is heavier than the lips, so it trails them instead of matching exactly.
        jaw += (lip - jaw) * 0.22 * step;

        // Mood drifts on its own schedule; speaking pushes the brows with the stressed word.
        if (time > nextMood) {
          const roll = Math.random();
          browTarget = roll < 0.3 ? -0.35 - Math.random() * 0.3 : roll < 0.75 ? Math.random() * 0.45 : 0.6 + Math.random() * 0.4;
          smileTarget = roll > 0.62 ? 0.35 + Math.random() * 0.5 : Math.random() * 0.2;
          headTiltTarget = (Math.random() - 0.5) * 0.9;
          nextMood = time + 2.4 + Math.random() * 4.5;
        }
        // Hovering reads as attention: brows lift a little, the hint of a smile arrives.
        const attention = pointerActive ? 1 : 0;
        const browDrive = browTarget + attention * 0.3 + emphasis * 0.55;
        const smileDrive = smileTarget + attention * 0.22;
        browRaise += (browDrive - browRaise) * 0.07 * step;
        smile += (smileDrive - smile) * 0.05 * step;
        // A smile that does not reach the eyes looks false, so the lids follow the mouth.
        squint += ((smile * 0.55 + emphasis * 0.15) - squint) * 0.06 * step;
        headTilt += (headTiltTarget - headTilt) * 0.03 * step;

        if (time > nextGlance) {
          // Saccades favour small movements; wide sweeps are rarer, as in a real gaze.
          const magnitude = Math.pow(Math.random(), 1.7);
          const angle = Math.random() * Math.PI * 2;
          glanceTargetX = Math.cos(angle) * magnitude;
          glanceTargetY = Math.sin(angle) * magnitude * 0.6;
          nextGlance = time + 0.9 + Math.random() * 2.6;
        }
        // When the pointer is over her, she follows it instead of glancing idly.
        if (pointerActive) {
          glanceTargetX = Math.max(-1, Math.min(1, pointerWorldX / Math.max(halfWidth, 0.001)));
          glanceTargetY = Math.max(-1, Math.min(1, pointerWorldY / Math.max(halfHeight, 0.001)));
        }
        // Eyes snap toward a target far faster than the head follows it.
        glanceX += (glanceTargetX - glanceX) * 0.2 * step;
        glanceY += (glanceTargetY - glanceY) * 0.2 * step;

        for (let i = 0; i < vertexCount; i += 1) {
          const o = i * 3;
          const u = baseUvs[i * 2];
          const v = baseUvs[i * 2 + 1];
          // Texture V is bottom-up; landmarks were measured top-down.
          const tv = 1 - v;
          let z = basePositions[o + 2];
          let du = 0;
          let dv = 0;

          // Eyes: shifting the texture inside each socket moves the iris within the eye.
          for (const eye of [LANDMARKS.leftEye, LANDMARKS.rightEye]) {
            const d = Math.hypot(u - eye.u, (tv - eye.v) * 1.45) / EYE_RADIUS;
            const w = falloff(d);
            if (w <= 0) continue;
            // Sampling further right shows texture from the right, which slides the iris
            // LEFT. The offset is negated so she looks where she is actually looking.
            du -= glanceX * 0.015 * w;
            dv += glanceY * 0.009 * w;
            // Blink samples from the lid above, so eyelid skin slides down over the eye.
            dv -= blink * 0.030 * w;
            // A squint is a partial, held version of the same motion.
            dv -= squint * 0.009 * w;
            z += blink * w * 0.035;
          }

          // Brows: the single biggest carrier of expression. Lifting samples from below, so
          // the brow line rides up the forehead; furrowing pulls it down and inward.
          for (const eye of [LANDMARKS.leftEye, LANDMARKS.rightEye]) {
            const bu = eye.u;
            const bv = eye.v - BROW_RISE;
            const d = Math.hypot((u - bu) / BROW_RADIUS_X, (tv - bv) / BROW_RADIUS_Y);
            const w = falloff(d);
            if (w <= 0) continue;
            dv += browRaise * 0.022 * w;
            // Furrowing draws the inner ends toward the nose; lifting spreads them apart.
            const inward = bu < 0.5 ? 1 : -1;
            du += inward * Math.max(0, -browRaise) * 0.010 * w;
            z += Math.max(0, -browRaise) * w * 0.045;
          }

          // Cheeks / mouth corners: a smile lifts the corners and bunches the cheek above.
          for (const side of [-1, 1]) {
            const cu = LANDMARKS.mouth.u + side * CORNER_OFFSET;
            const cv = LANDMARKS.mouth.v - 0.004;
            const d = Math.hypot(u - cu, (tv - cv) * 1.25) / CORNER_RADIUS;
            const w = falloff(d);
            if (w <= 0) continue;
            dv += smile * 0.020 * w;
            du += side * smile * 0.012 * w;
            z += smile * w * 0.06;
          }

          // Jaw: the mass below the lip line swings with a wide vowel, so the whole lower
          // face moves rather than a band of lips sliding over a static chin.
          const jd = Math.hypot((u - LANDMARKS.mouth.u) / JAW_RADIUS_X, (tv - (LANDMARKS.mouth.v + JAW_DROP)) / JAW_RADIUS_Y);
          const jw = falloff(jd);
          if (jw > 0) {
            dv -= jaw * 0.010 * jw;
            z += jw * jaw * 0.03;
          }

          // Lips part at the measured lip line. Each lip's texture is carried away from the
          // line (upper up, lower down, about three times as far, as a jaw does) and clamped
          // at it, so the gap between them samples the dark line itself: the mouth opens onto
          // shadow instead of one lip sliding over the other. A dv above 0 samples from below,
          // so content moves up; below 0 samples from above, so content moves down.
          const across = Math.abs(u - LANDMARKS.mouth.u) / MOUTH_HALF_WIDTH;
          const below = tv - LANDMARKS.mouth.v;
          if (across < 1 && below > -UPPER_LIP_REACH && below < LOWER_LIP_REACH) {
            // An oval opening: the corners stay sealed and the centre opens widest.
            const width = falloff(across / 0.8);
            const reach = below >= 0 ? LOWER_LIP_REACH : UPPER_LIP_REACH;
            const carry = lip * (below >= 0 ? LOWER_LIP_TRAVEL : UPPER_LIP_TRAVEL) * width * falloff(Math.abs(below) / reach);
            let shade = 1;
            if (carry > 0 && Math.abs(below) < carry) {
              // Inside the gap: a narrow band around the lip line, squeezed, not one pixel
              // row stretched (which striped), and shaded down by the vertex colour.
              dv += LANDMARKS.mouth.v + below * 0.15 - tv;
              shade = 0.42;
              z -= lip * width * 0.025;
            } else if (carry > 0) {
              dv += below >= 0 ? -carry : carry;
            }
            colors[o] = colors[o + 1] = colors[o + 2] = shade;
          }

          // Pointer ripple across the relief.
          if (pointerActive || ripple > 0.01) {
            const dx = basePositions[o] - pointerWorldX;
            const dy = basePositions[o + 1] - pointerWorldY;
            const d = Math.hypot(dx, dy) / INFLUENCE_RADIUS;
            const w = falloff(d);
            if (w > 0) z += w * (0.1 + ripple * 0.3) * Math.sin(d * 7 - time * 5);
          }

          positions[o + 2] = z;
          uvs[i * 2] = u + du;
          uvs[i * 2 + 1] = v - dv;
        }

        position.needsUpdate = true;
        uv.needsUpdate = true;
        color.needsUpdate = true;
        geometry.computeVertexNormals();
        ripple *= Math.pow(0.9, step);

        // Parallax: a slight turn toward the pointer sells the depth the relief provides.
        const targetYaw = pointerActive ? (pointerWorldX / Math.max(halfWidth, 0.001)) * 0.2 : Math.sin(time * 0.3) * 0.05;
        const targetPitch = pointerActive ? (-pointerWorldY / Math.max(halfHeight, 0.001)) * 0.13 : Math.sin(time * 0.23) * 0.03;
        field.rotation.y += (targetYaw - field.rotation.y) * 0.05 * step;
        field.rotation.x += (targetPitch - field.rotation.x) * 0.05 * step;
        // A slow tilt keeps the head alive between gestures.
        field.rotation.z += (headTilt * 0.05 - field.rotation.z) * 0.03 * step;

        // Drift the coloured lights so the palette keeps shifting across her face.
        key.position.x = -2.2 + Math.sin(time * 0.21) * 1.1;
        key.position.y = 1.6 + Math.cos(time * 0.17) * 0.5;
        rim.position.x = 2.6 + Math.sin(time * 0.19 + 2) * 0.9;
        bounce.intensity = 0.6 + Math.sin(time * 0.6) * 0.2;
      }

      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(render);
    };

    const start = () => {
      if (!animationFrame && !disposed) { lastTimestamp = 0; animationFrame = window.requestAnimationFrame(render); }
    };
    const stop = () => { window.cancelAnimationFrame(animationFrame); animationFrame = 0; };
    const syncPlayback = () => { if (document.hidden || !onScreen) stop(); else start(); };

    document.addEventListener("visibilitychange", syncPlayback);
    const onContextLost = (event: Event) => { event.preventDefault(); stop(); setFallback(true); };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    let hasBeenVisible = false;
    const intersectionObserver = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (visible) hasBeenVisible = true;
      // A false negative before first paint must not freeze the portrait for good.
      onScreen = visible || !hasBeenVisible;
      syncPlayback();
    }, { threshold: 0.01 });
    intersectionObserver.observe(host);
    start();

    return () => {
      disposed = true;
      stop();
      document.removeEventListener("visibilitychange", syncPlayback);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      intersectionObserver.disconnect();
      resizeObserver.disconnect();
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointerleave", onPointerLeave);
      host.removeEventListener("pointercancel", onPointerLeave);
      geometry?.dispose();
      material?.dispose();
      texture?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      scene.clear();
      image.onload = null;
      image.onerror = null;
    };
  }, []);

  return (
    <div className={`portrait-particle-stage ${disturbed ? "is-disturbed" : ""}`} role="img" aria-label="User-provided FREYA portrait as a lit 3D relief that follows the cursor" style={{ filter: "grayscale(100%) brightness(90%)" }}>
      <div className="portrait-particle-host" ref={hostRef} aria-hidden="true" />
      {fallback && <Image className="portrait-static-fallback" src={portraitAsset} alt="" fill sizes="(max-width: 850px) 88vw, 19vw" priority />}
      {/* Nothing sits under her unless she is speaking; then the words appear as she says them. */}
      {caption.speaking && caption.words.length > 0 && (
        <span className="portrait-caption" aria-hidden="true">
          {caption.words.map((word, index) => (
            <span key={`${index}-${word}`} className={index === caption.index ? "spoken-now" : "spoken-ahead"}>{word}</span>
          ))}
        </span>
      )}
      <span className="sr-only">The supplied portrait is displayed as a lit 3D relief driven by its own brightness. It is not a generated or scanned 3D face.</span>
    </div>
  );
}
