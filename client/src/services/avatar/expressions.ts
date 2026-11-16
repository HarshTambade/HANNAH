/**
 * What HANNAH's avatar should be doing, as plain numbers.
 *
 * This file has no three.js code so it can be tested on its own. AvatarRig.ts
 * turns these numbers into bone rotations and face shapes.
 *
 * Conventions (model space, radians): x > 0 nods down, y > 0 turns toward the
 * viewer's right, z tilts. Arm "A" is the arm on the viewer's right; arm "B"
 * is written in the same convention and mirrored when applied, so a symmetric
 * pose uses the same numbers for both.
 */
import type { Emotion } from "../../types";

export type AvatarActivity = "idle" | "listening" | "thinking" | "speaking";
export type Gesture = "wave" | "hmph" | "jolt" | "sigh" | "giggle" | "nod";

export const BONE_ROLES = ["spine", "chest", "neck", "head", "eyes", "upperArmA", "lowerArmA", "upperArmB", "lowerArmB"] as const;
export type BoneRole = (typeof BONE_ROLES)[number];
/** smile 0..1 (up to 1.35 where the model allows a bigger grin) · lid −0.4 (wide) .. 1 (closed) · frown/browDown/browUp 0..1 · mouthOpen 0..1 · mouthRound 0 (wide) .. 1 ("o") */
export const FACE_CHANNELS = ["smile", "lid", "frown", "browDown", "browUp", "mouthOpen", "mouthRound"] as const;
export type FaceChannel = (typeof FACE_CHANNELS)[number];
export type Vec3 = readonly [number, number, number];
export type Pose = { bones?: Partial<Record<BoneRole, Vec3>>; face?: Partial<Record<FaceChannel, number>>; bounce?: number };

/** Flat numeric pose, keyed "head.x", "face.smile", "bounce". */
export type PoseVector = Record<string, number>;

const AXES = ["x", "y", "z"] as const;

export function poseKeys() {
  return [
    ...BONE_ROLES.flatMap((role) => AXES.map((axis) => `${role}.${axis}`)),
    ...FACE_CHANNELS.map((channel) => `face.${channel}`),
    "bounce",
  ];
}

export function emptyPose(): PoseVector {
  return Object.fromEntries(poseKeys().map((key) => [key, 0]));
}

function flatten(pose: Pose): PoseVector {
  const out: PoseVector = {};
  for (const [role, value] of Object.entries(pose.bones ?? {})) AXES.forEach((axis, index) => { out[`${role}.${axis}`] = (value as Vec3)[index]; });
  for (const [channel, value] of Object.entries(pose.face ?? {})) out[`face.${channel}`] = value as number;
  if (pose.bounce !== undefined) out.bounce = pose.bounce;
  return out;
}

/** Resting pose for each emotion. */
export const EMOTION_POSES: Record<Emotion, Pose> = {
  neutral: {
    bones: { head: [0.02, 0, 0.035] },
    face: { smile: 0.22 },
  },
  happy: {
    bones: { head: [-0.03, 0.05, 0.13], chest: [-0.04, 0, 0], upperArmA: [0, 0, 0.08], upperArmB: [0, 0, 0.08] },
    face: { smile: 1.3 },
    bounce: 1,
  },
  sad: {
    bones: {
      head: [0.24, -0.06, -0.07], neck: [0.06, 0, 0], chest: [0.1, 0, 0], spine: [0.04, 0, 0],
      upperArmA: [-0.12, 0, -0.1], lowerArmA: [-0.35, 0, -0.25], upperArmB: [-0.12, 0, -0.1], lowerArmB: [-0.35, 0, -0.25],
    },
    face: { smile: 0, lid: 0.36, frown: 1, browUp: 0.5 },
  },
  angry: {
    bones: {
      head: [0.05, 0.3, -0.06], chest: [-0.03, 0.06, 0],
      upperArmA: [0.1, 0, 0.5], lowerArmA: [0, 0, -1.35], upperArmB: [0.1, 0, 0.5], lowerArmB: [0, 0, -1.35],
    },
    face: { smile: 0, lid: 0.3, browDown: 1 },
  },
  surprised: {
    bones: {
      head: [-0.12, 0, 0], chest: [-0.07, 0, 0],
      upperArmA: [0, 0, 0.12], lowerArmA: [-0.3, 0, 0.25], upperArmB: [0, 0, 0.12], lowerArmB: [-0.3, 0, 0.25],
    },
    face: { smile: 0, lid: -0.34, browUp: 1, mouthOpen: 0.55, mouthRound: 1 },
    bounce: 1,
  },
  thinking: {
    bones: {
      head: [-0.07, -0.16, 0.15], eyes: [-0.25, -0.2, 0],
      // Hand to the cheek on her own side; crossing the body drags the wide sleeve over her face.
      upperArmA: [-0.35, 0, 0.05], lowerArmA: [-2, 0, -0.2],
    },
    face: { smile: 0.1, lid: 0.12 },
  },
};

/** What the current activity changes. `set` replaces the emotion's value (by `weight`); `add` is added on top. */
export const ACTIVITY_LAYERS: Record<AvatarActivity, { set?: Pose; add?: Pose; weight: number }> = {
  idle: { weight: 0 },
  listening: { add: { bones: { head: [0.03, 0, 0.09], chest: [0.04, 0, 0] }, face: { smile: 0.08 } }, weight: 1 },
  thinking: { set: EMOTION_POSES.thinking, weight: 1 },
  speaking: { add: { face: { smile: 0.05 } }, weight: 1 },
};

/** The pose to move toward for an emotion and activity, before life motion and gestures. */
export function targetPose(emotion: Emotion, activity: AvatarActivity): PoseVector {
  const pose = { ...emptyPose(), ...flatten(EMOTION_POSES[emotion] ?? EMOTION_POSES.neutral) };
  const layer = ACTIVITY_LAYERS[activity] ?? ACTIVITY_LAYERS.idle;
  if (layer.set) {
    const set = flatten(layer.set);
    for (const key of Object.keys(pose)) {
      // Keep the emotion's face (a sad HANNAH still looks sad while thinking);
      // the activity takes over the head and arms.
      const value = set[key] ?? (key.startsWith("face.") || key === "bounce" ? pose[key] : 0);
      const weight = key.startsWith("face.") ? layer.weight * 0.35 : layer.weight;
      pose[key] = pose[key] + (value - pose[key]) * weight;
    }
  }
  if (layer.add) for (const [key, value] of Object.entries(flatten(layer.add))) pose[key] += value * layer.weight;
  return pose;
}

const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Rise over `attack` seconds, hold, fall over `release` seconds. */
export function envelope(t: number, duration: number, attack: number, release: number) {
  if (t <= 0 || t >= duration) return 0;
  return Math.min(smoothstep(0, attack, t), 1 - smoothstep(duration - release, duration, t));
}

export const GESTURE_DURATION: Record<Gesture, number> = { wave: 2.4, hmph: 1.5, jolt: 1.3, sigh: 2.6, giggle: 1.6, nod: 0.9 };

/** Additive pose for a one-shot gesture `t` seconds after it started. */
export function gesturePose(gesture: Gesture, t: number): PoseVector {
  const duration = GESTURE_DURATION[gesture];
  const out: PoseVector = {};
  const add = (key: string, value: number) => { out[key] = (out[key] ?? 0) + value; };
  switch (gesture) {
    case "wave": {
      const e = envelope(t, duration, 0.4, 0.5);
      add("upperArmA.x", -0.3 * e);
      add("upperArmA.z", 1.25 * e);
      add("lowerArmA.z", (1.2 + 0.34 * Math.sin(t * Math.PI * 2 * 2.3)) * e);
      add("head.z", 0.08 * e);
      add("face.smile", 0.7 * e);
      break;
    }
    case "hmph": {
      const e = envelope(t, duration, 0.12, 0.7);
      add("head.y", 0.22 * e);
      add("head.x", -0.12 * e);
      add("face.lid", 0.55 * e);
      break;
    }
    case "jolt": {
      const e = envelope(t, duration, 0.1, 1);
      add("chest.x", -0.08 * e);
      add("head.x", -0.08 * e);
      add("face.lid", -0.08 * e);
      add("bounce", 1.4 * e);
      break;
    }
    case "sigh": {
      const inhale = envelope(t, 1.3, 0.6, 0.6);
      const exhale = envelope(t - 1, duration - 1, 0.4, 0.9);
      add("chest.x", -0.06 * inhale + 0.09 * exhale);
      add("head.x", -0.04 * inhale + 0.1 * exhale);
      add("face.lid", 0.2 * exhale);
      break;
    }
    case "giggle": {
      const e = envelope(t, duration, 0.1, 0.6);
      add("head.z", 0.1 * Math.sin(t * Math.PI * 2 * 2.6) * e);
      add("head.x", -0.04 * e);
      add("chest.x", 0.025 * Math.sin(t * Math.PI * 2 * 5.2) * e);
      add("face.smile", 1.25 * e);
      add("face.lid", 0.35 * e);
      add("face.mouthOpen", 0.35 * (0.6 + 0.4 * Math.sin(t * Math.PI * 2 * 5.2)) * e);
      add("bounce", 0.5 * e);
      break;
    }
    case "nod": {
      const e = envelope(t, duration, 0.1, 0.4);
      add("head.x", 0.14 * Math.sin(t * Math.PI * 2 * 1.6) * e);
      break;
    }
  }
  return out;
}

/** Gesture to play when HANNAH's emotion changes to `emotion`, if any. */
export function gestureForEmotion(emotion: Emotion): Gesture | null {
  return ({ happy: "wave", angry: "hmph", surprised: "jolt", sad: "sigh", neutral: null, thinking: null } as const)[emotion];
}

/**
 * Mouth movement while talking, 0..1. Syllable-rate flaps (about 4 a second)
 * that vary in size, with short pauses between phrases. Deterministic in `t`.
 */
export function talkOpenness(t: number) {
  const syllable = Math.max(0, Math.sin(t * Math.PI * 2 * 4.1 + 1.4 * Math.sin(t * Math.PI * 2 * 0.73)));
  const size = 0.55 + 0.45 * Math.sin(t * Math.PI * 2 * 1.37 + 0.4);
  const phrase = smoothstep(-0.85, -0.55, Math.sin(t * Math.PI * 2 * 0.21 + 0.6));
  return Math.min(1, syllable * size * phrase);
}

/** Random blinking, sometimes twice. `random` is injectable for tests. */
export class BlinkScheduler {
  private next: number;
  private started = -1;
  private double = false;

  constructor(private readonly random: () => number = Math.random, now = 0) {
    this.next = now + 1 + random() * 2;
  }

  /** Lid closure 0..1 from the blink at time `now` (seconds). */
  value(now: number) {
    if (this.started < 0 && now >= this.next) {
      this.started = now;
      this.double = this.random() < 0.2;
    }
    if (this.started < 0) return 0;
    const t = now - this.started;
    const single = 0.16;
    const length = this.double ? single * 2 + 0.08 : single;
    if (t >= length) {
      this.started = -1;
      this.next = now + 2.2 + this.random() * 3.8;
      return 0;
    }
    const local = this.double && t > single + 0.08 ? t - single - 0.08 : t;
    if (local > single) return 0;
    return Math.sin((local / single) * Math.PI);
  }
}

/** Slow, small, never-repeating sway so she never freezes. */
export function lifeMotion(t: number, amount = 1): PoseVector {
  const n = (a: number, b: number, c: number) => Math.sin(t * a) * 0.6 + Math.sin(t * b + 1.7) * 0.3 + Math.sin(t * c + 4.1) * 0.1;
  return {
    "head.x": 0.025 * n(0.61, 1.33, 2.9) * amount,
    "head.y": 0.04 * n(0.37, 0.89, 2.1) * amount,
    "head.z": 0.025 * n(0.47, 1.07, 2.3) * amount,
    "chest.x": 0.018 * Math.sin(t * 1.75) * amount,
    "spine.z": 0.018 * n(0.29, 0.71, 1.9) * amount,
    "eyes.y": 0.08 * n(0.53, 1.9, 3.7) * amount,
  };
}

/** Critically damped step of `current` toward `target`. */
export function dampPose(current: PoseVector, target: PoseVector, lambda: number, delta: number) {
  const factor = 1 - Math.exp(-lambda * delta);
  for (const key of Object.keys(target)) current[key] = (current[key] ?? 0) + (target[key] - (current[key] ?? 0)) * factor;
  return current;
}
