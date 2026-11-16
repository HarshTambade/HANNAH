import { Box3, BufferAttribute, type BufferGeometry, Float32BufferAttribute, Vector3 } from "three";

export type MorphRepairResult = "none" | "ok" | "repaired" | "dropped";

const UNIT_SCALES = [100, 1000, 10, 0.01, 0.001, 0.1];

function percentile(values: number[], fraction: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/**
 * Fix morph targets that were exported in the wrong units.
 *
 * Some FBX → glTF conversions (the bundled Sketchfab avatar is one) write each
 * blend shape as `(base + delta) × 100 − base` instead of `delta`. Applied as-is,
 * a weight of 1 throws the whole face hundreds of units off screen. This
 * detects that pattern, recovers the real deltas, and drops shapes that can't
 * be recovered so they can never make the face vanish. Normal deltas from such
 * exports are equally wrong, so they're removed; the shading stays on the base
 * normals, which is fine for small facial changes.
 */
export function repairMorphTargets(geometry: BufferGeometry): MorphRepairResult {
  const targets = geometry.morphAttributes.position;
  const base = geometry.getAttribute("position");
  if (!targets?.length || !base) return "none";

  const bounds = new Box3().setFromBufferAttribute(base as BufferAttribute);
  const diagonal = bounds.getSize(new Vector3()).length() || 1;
  const relative = geometry.morphTargetsRelative;
  const count = base.count;
  const step = Math.max(1, Math.floor(count / 400));

  const delta = (target: (typeof targets)[number], index: number, scale: number | null) => {
    const bx = base.getX(index), by = base.getY(index), bz = base.getZ(index);
    let x = target.getX(index), y = target.getY(index), z = target.getZ(index);
    if (!relative) { x -= bx; y -= by; z -= bz; }
    if (scale !== null) { x = (x + bx) / scale - bx; y = (y + by) / scale - by; z = (z + bz) / scale - bz; }
    return [x, y, z] as const;
  };
  const sampleMagnitudes = (target: (typeof targets)[number], scale: number | null) => {
    const magnitudes: number[] = [];
    for (let index = 0; index < count; index += step) magnitudes.push(Math.hypot(...delta(target, index, scale)));
    return magnitudes;
  };

  const broken = targets.some((target) => percentile(sampleMagnitudes(target, null), 0.5) > diagonal * 0.5);
  if (!broken) return "ok";

  let best: { scale: number; worst: number } | null = null;
  for (const scale of UNIT_SCALES) {
    const worst = Math.max(...targets.map((target) => percentile(sampleMagnitudes(target, scale), 0.98)));
    if (worst <= diagonal * 0.25 && (!best || worst < best.worst)) best = { scale, worst };
  }

  if (!best) {
    geometry.morphAttributes = {};
    return "dropped";
  }

  geometry.morphAttributes.position = targets.map((target) => {
    const values = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const [x, y, z] = delta(target, index, best.scale);
      values[index * 3] = x;
      values[index * 3 + 1] = y;
      values[index * 3 + 2] = z;
    }
    const attribute = new Float32BufferAttribute(values, 3);
    attribute.name = target.name;
    return attribute;
  });
  geometry.morphTargetsRelative = true;
  delete geometry.morphAttributes.normal;
  return "repaired";
}
