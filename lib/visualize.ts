/**
 * /visualize: a description becomes a 3D particle form on the canvas.
 *
 * A model composes the subject from simple solids (ellipsoids, boxes, cylinders, cones, tori
 * and tubes along a path) with positions, sizes, rotations and colours. Points are then
 * scattered over those surfaces here, in the browser, and the canvas's existing particle
 * renderer draws them. A human face uses a different technique: a relief built from the
 * brightness of FREYA's portrait, since solids make a poor face.
 *
 * Validation and sampling are pure and framework-free, so both are tested directly.
 */
export const SHAPES = ["ellipsoid", "box", "cylinder", "cone", "torus", "tube"] as const;
export type ShapeKind = (typeof SHAPES)[number];
export type Vec3 = [number, number, number];

export type VisualPart = {
  shape: ShapeKind;
  position: Vec3;
  /** Full extents along x, y, z before rotation. */
  size: Vec3;
  /** Degrees around x, y, z. */
  rotation: Vec3;
  color: string;
  /** Path for a tube, in the same space as position. */
  path?: Vec3[];
  /** Tube radius, or a torus's tube thickness. */
  radius?: number;
  /** Box or cylinder only: width at the top as a share of the bottom (1 = straight, 0.2 = tapering). */
  taper?: number;
};

export type VisualSpec = {
  title: string;
  technique: "parts" | "portrait";
  parts: VisualPart[];
};

export const MAX_PARTS = 60;
/** Points in a visualised form: enough to read as a solid shape, light enough for a laptop GPU. */
export const FORM_POINTS = 6000;
const MAX_PATH = 24;
const DEFAULT_COLOR = "#d9d1c2";

export const VISUALIZE_PROMPT = `You build 3D particle sculptures for a small canvas. The user describes something; you compose it from simple solids, and points are scattered over their surfaces.

Return JSON: {"title":"2-4 word name","technique":"parts","parts":[...]}
Each part: {"shape":"ellipsoid|box|cylinder|cone|torus|tube","position":[x,y,z],"size":[sx,sy,sz],"rotation":[rx,ry,rz],"color":"#rrggbb"}
- Space: the whole object fits inside -1..1 on every axis. y is up, the object faces +z (towards the viewer).
- size is the full width, height and depth of the part before rotation. rotation is in degrees.
- cylinder and cone run along y (a cone's tip points to +y). torus lies flat in the x-z plane; add "radius" for its thickness.
- box and cylinder may add "taper": 0.1-1, the top's width as a share of the bottom's (tower legs, spires, tree trunks, vases, pyramids).
- tube: thin curved things (tails, legs, stems, handles, cables, horns): give "path":[[x,y,z],...] (2-12 points) and "radius". position/size are ignored for tubes.
- First decide what makes the subject recognisable at a glance (a fox: long pointed snout, big triangular ears, a bushy tail nearly as big as its body, white chest and tail tip, thin dark legs; the Eiffel Tower: four splayed legs meeting in a tapering lattice spire with two platforms). Build those features clearly, slightly exaggerated, like a stylised sculpture.
- Animals, vehicles, buildings and objects with detail: 15-45 parts. Simple objects: fewer. Pose animals naturally (a sitting animal has its haunches down and front legs straight).
- Get proportions and placement right. Connected parts must overlap (a head sits on the neck, the neck on the body; legs start inside the body): check each part's position against its neighbour's position and size. No floating parts unless the subject really has them. Mirror left/right parts exactly. Use believable colours, but avoid black (it doesn't show on the dark canvas): use a very dark grey instead.
- For a human face or head (portrait, person's face, woman, man), return {"title":"...","technique":"portrait","parts":[]}: a dedicated renderer draws it.
- Abstract ideas: make an elegant symbolic sculpture from the same solids.`;

/** The card's Refine button: changes that one sculpture instead of starting a new one. */
export const REFINE_PROMPT = `${VISUALIZE_PROMPT}

You are changing an existing sculpture, not starting again. CURRENT FORM holds its parts. Return the complete updated parts list: keep every part the request doesn't touch exactly as it is (same position, size, rotation and colour), and change or add only what was asked for. Keep the title unless the subject itself changed. Always use technique "parts".`;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function vec(value: unknown, fallback: Vec3, low: number, high: number): Vec3 {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  return [0, 1, 2].map((axis) => (isNumber(value[axis]) ? clamp(value[axis] as number, low, high) : fallback[axis])) as Vec3;
}

function color(value: unknown) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : DEFAULT_COLOR;
}

/** Keeps only well-formed parts, with every number bounded. Never throws. */
export function validateSpec(raw: unknown): VisualSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const title = typeof input.title === "string" && input.title.trim() ? input.title.replace(/\s+/g, " ").trim().slice(0, 48) : "Visualization";
  if (input.technique === "portrait") return { title, technique: "portrait", parts: [] };
  const parts: VisualPart[] = [];
  for (const item of Array.isArray(input.parts) ? input.parts : []) {
    if (!item || typeof item !== "object") continue;
    const part = item as Record<string, unknown>;
    if (!SHAPES.includes(part.shape as ShapeKind)) continue;
    const shape = part.shape as ShapeKind;
    const base: VisualPart = {
      shape,
      position: vec(part.position, [0, 0, 0], -1.5, 1.5),
      size: vec(part.size, [0.3, 0.3, 0.3], 0.01, 3),
      rotation: vec(part.rotation, [0, 0, 0], -360, 360),
      color: color(part.color),
    };
    if (isNumber(part.radius)) base.radius = clamp(part.radius, 0.005, 0.6);
    if ((shape === "box" || shape === "cylinder") && isNumber(part.taper)) base.taper = clamp(part.taper, 0.05, 1);
    if (shape === "tube") {
      const path = (Array.isArray(part.path) ? part.path : []).slice(0, MAX_PATH).map((point) => vec(point, [0, 0, 0], -1.5, 1.5));
      if (path.length < 2) continue;
      base.path = path;
      base.radius = base.radius ?? 0.04;
    }
    parts.push(base);
    if (parts.length >= MAX_PARTS) break;
  }
  if (!parts.length) return null;
  return { title, technique: "parts", parts };
}

// --- sampling (browser) ----------------------------------------------------------------------

/** Small deterministic generator, so the same spec always gives the same cloud. */
export function prng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}

function hexToRgb(hex: string): Vec3 {
  const value = parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function rotate([x, y, z]: Vec3, [rx, ry, rz]: Vec3): Vec3 {
  const [a, b, c] = [rx, ry, rz].map((degrees) => (degrees * Math.PI) / 180);
  // X, then Y, then Z.
  let y1 = y * Math.cos(a) - z * Math.sin(a);
  let z1 = y * Math.sin(a) + z * Math.cos(a);
  const x2 = x * Math.cos(b) + z1 * Math.sin(b);
  z1 = -x * Math.sin(b) + z1 * Math.cos(b);
  const x3 = x2 * Math.cos(c) - y1 * Math.sin(c);
  y1 = x2 * Math.sin(c) + y1 * Math.cos(c);
  return [x3, y1, z1];
}

/** Rough surface area, only used to share points between parts fairly. */
function area(part: VisualPart): number {
  const [sx, sy, sz] = part.size.map((value) => value / 2);
  switch (part.shape) {
    case "ellipsoid": {
      const p = 1.6;
      return 4 * Math.PI * (((sx * sy) ** p + (sx * sz) ** p + (sy * sz) ** p) / 3) ** (1 / p);
    }
    case "box": return 8 * (sx * sy + sx * sz + sy * sz);
    case "cylinder": return 2 * Math.PI * ((sx + sz) / 2) * 2 * sy + 2 * Math.PI * sx * sz;
    case "cone": return Math.PI * ((sx + sz) / 2) * Math.hypot(2 * sy, (sx + sz) / 2) + Math.PI * sx * sz;
    case "torus": {
      const tube = part.radius ?? sx * 0.25;
      return 4 * Math.PI * Math.PI * Math.max(0.01, sx - tube) * tube;
    }
    case "tube": {
      const path = part.path ?? [];
      let length = 0;
      for (let index = 1; index < path.length; index += 1) length += Math.hypot(...path[index].map((value, axis) => value - path[index - 1][axis]) as Vec3);
      return 2 * Math.PI * (part.radius ?? 0.04) * length;
    }
  }
}

/** One point on a part's surface, in the part's local frame (tubes return world space). */
function surfacePoint(part: VisualPart, random: () => number): Vec3 {
  const point = untaperedPoint(part, random);
  if (part.taper === undefined || part.taper >= 1) return point;
  // Narrow towards the top: scale x and z by height.
  const half = Math.max(0.0001, part.size[1] / 2);
  const width = 1 + (part.taper - 1) * ((point[1] + half) / (2 * half));
  return [point[0] * width, point[1], point[2] * width];
}

function untaperedPoint(part: VisualPart, random: () => number): Vec3 {
  const [sx, sy, sz] = part.size.map((value) => value / 2);
  const angle = random() * Math.PI * 2;
  switch (part.shape) {
    case "ellipsoid": {
      const u = random() * 2 - 1;
      const ring = Math.sqrt(1 - u * u);
      return [ring * Math.cos(angle) * sx, u * sy, ring * Math.sin(angle) * sz];
    }
    case "box": {
      const faces = [sy * sz, sy * sz, sx * sz, sx * sz, sx * sy, sx * sy];
      let pick = random() * faces.reduce((sum, value) => sum + value, 0);
      let face = 0;
      while (face < 5 && pick > faces[face]) pick -= faces[face++];
      const a = random() * 2 - 1;
      const b = random() * 2 - 1;
      const sign = face % 2 ? -1 : 1;
      if (face < 2) return [sign * sx, a * sy, b * sz];
      if (face < 4) return [a * sx, sign * sy, b * sz];
      return [a * sx, b * sy, sign * sz];
    }
    case "cylinder": {
      const side = 2 * sy * Math.PI * (sx + sz);
      const cap = Math.PI * sx * sz;
      if (random() * (side + 2 * cap) < side) return [Math.cos(angle) * sx, (random() * 2 - 1) * sy, Math.sin(angle) * sz];
      const radius = Math.sqrt(random());
      return [Math.cos(angle) * sx * radius, random() < 0.5 ? sy : -sy, Math.sin(angle) * sz * radius];
    }
    case "cone": {
      if (random() < 0.8) {
        const t = 1 - Math.sqrt(random()); // denser near the wide base, as the surface is
        return [Math.cos(angle) * sx * t, -sy + 2 * sy * (1 - t), Math.sin(angle) * sz * t];
      }
      const radius = Math.sqrt(random());
      return [Math.cos(angle) * sx * radius, -sy, Math.sin(angle) * sz * radius];
    }
    case "torus": {
      const tube = part.radius ?? sx * 0.25;
      const major = Math.max(0.01, sx - tube);
      const around = random() * Math.PI * 2;
      return [(major + tube * Math.cos(around)) * Math.cos(angle), tube * Math.sin(around) * (sy / Math.max(0.01, sx)) * 2, (major + tube * Math.cos(around)) * Math.sin(angle) * (sz / Math.max(0.01, sx))];
    }
    case "tube": {
      const path = part.path!;
      const lengths = path.slice(1).map((point, index) => Math.hypot(...point.map((value, axis) => value - path[index][axis]) as Vec3));
      let distance = random() * lengths.reduce((sum, value) => sum + value, 0);
      let segment = 0;
      while (segment < lengths.length - 1 && distance > lengths[segment]) distance -= lengths[segment++];
      const from = path[segment];
      const to = path[segment + 1];
      const t = lengths[segment] ? distance / lengths[segment] : 0;
      const along: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const length = Math.hypot(...along) || 1;
      const direction = along.map((value) => value / length) as Vec3;
      // Any two directions perpendicular to the segment span its cross-section.
      const helper: Vec3 = Math.abs(direction[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const first: Vec3 = [direction[1] * helper[2] - direction[2] * helper[1], direction[2] * helper[0] - direction[0] * helper[2], direction[0] * helper[1] - direction[1] * helper[0]];
      const firstLength = Math.hypot(...first) || 1;
      const u = first.map((value) => value / firstLength) as Vec3;
      const v: Vec3 = [direction[1] * u[2] - direction[2] * u[1], direction[2] * u[0] - direction[0] * u[2], direction[0] * u[1] - direction[1] * u[0]];
      const radius = part.radius ?? 0.04;
      return [0, 1, 2].map((axis) => from[axis] + along[axis] * t + (u[axis] * Math.cos(angle) + v[axis] * Math.sin(angle)) * radius) as Vec3;
    }
  }
}

export type PointCloud = { positions: Float32Array; colors: Float32Array };

/** Scatters `count` points over the spec's parts, centred and scaled to `extent`. */
export function samplePartsCloud(spec: VisualSpec, count: number, extent = 1.5, seed = 7): PointCloud {
  const random = prng(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const areas = spec.parts.map((part) => Math.max(0.0005, area(part)));
  // Small parts (eyes, buttons) still get enough points to be seen.
  const weights = areas.map((value) => Math.sqrt(value) * 0.35 + value);
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const rgb = spec.parts.map((part) => hexToRgb(part.color));
  let index = 0;
  spec.parts.forEach((part, partIndex) => {
    const share = partIndex === spec.parts.length - 1 ? count - index : Math.round((weights[partIndex] / total) * count);
    for (let n = 0; n < share && index < count; n += 1, index += 1) {
      const local = surfacePoint(part, random);
      const world = part.shape === "tube" ? local : rotate(local, part.rotation).map((value, axis) => value + part.position[axis]) as Vec3;
      positions.set(world, index * 3);
      const shade = 0.82 + random() * 0.3;
      colors.set(rgb[partIndex].map((value) => Math.min(1, value * shade)) as Vec3, index * 3);
    }
  });
  return fit(positions, colors, index, count, extent);
}

/** Centres the cloud and scales its largest half-extent to `extent`; unused slots collapse. */
function fit(positions: Float32Array, colors: Float32Array, used: number, count: number, extent: number): PointCloud {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < used; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      low[axis] = Math.min(low[axis], positions[index * 3 + axis]);
      high[axis] = Math.max(high[axis], positions[index * 3 + axis]);
    }
  }
  const centre = low.map((value, axis) => (value + high[axis]) / 2);
  const half = Math.max(0.001, ...low.map((value, axis) => (high[axis] - value) / 2));
  const scale = extent / half;
  for (let index = 0; index < count; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      positions[index * 3 + axis] = index < used ? (positions[index * 3 + axis] - centre[axis]) * scale : 0;
    }
  }
  return { positions, colors };
}

/**
 * A relief from an image's brightness: bright pixels come forward, dark ones are skipped.
 * `pixels` is RGBA, row-major. Used with FREYA's portrait for faces.
 */
export function sampleReliefCloud(pixels: Uint8ClampedArray, width: number, height: number, count: number, extent = 1.5, seed = 11): PointCloud {
  const random = prng(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const luminance = (offset: number) => (0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2]) / 255;
  let index = 0;
  for (let attempt = 0; attempt < count * 40 && index < count; attempt += 1) {
    const x = Math.floor(random() * width);
    const y = Math.floor(random() * height);
    const offset = (y * width + x) * 4;
    const light = luminance(offset);
    // Brighter areas get more points; near-black background gets none.
    if (light < 0.12 || random() > light * 1.15) continue;
    positions.set([(x / width - 0.5) * 2 * (width / height), -(y / height - 0.5) * 2, light * 0.55], index * 3);
    colors.set([pixels[offset] / 255, pixels[offset + 1] / 255, pixels[offset + 2] / 255].map((value) => Math.min(1, value * 1.15)) as Vec3, index * 3);
    index += 1;
  }
  return fit(positions, colors, index, count, extent);
}
