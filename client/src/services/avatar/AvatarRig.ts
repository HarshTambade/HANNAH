/**
 * Drives HANNAH's 3D model: facial expressions, blinking, talking, gaze, and
 * body poses and gestures for each emotion, layered on top of the model's own
 * idle animation.
 *
 * Works with any rigged GLB. Face shapes are found by common blend-shape names
 * (ARKit, VRM, Ready Player Me, plain "smile"/"blink"); body bones by common
 * bone names (Mixamo, VRM, Unity/Blender humanoids). The bundled model's two
 * unnamed shapes (blink and smile) are recognized by its bone names. A model
 * with no matching shapes or bones still animates whatever it has.
 */
import { CanvasTexture, Euler, Mesh, MeshBasicMaterial, type Object3D, PlaneGeometry, Quaternion, SkinnedMesh, Vector3 } from "three";
import type { Emotion } from "../../types";
import {
  BlinkScheduler, BONE_ROLES, type AvatarActivity, type BoneRole, dampPose, emptyPose, gestureForEmotion, GESTURE_DURATION,
  type Gesture, gesturePose, lifeMotion, type PoseVector, talkOpenness, targetPose,
} from "./expressions";

type Target = { mesh: Mesh; index: number };
type ShapeChannel = "blink" | "smile" | "mouthOpen" | "mouthRound" | "frown" | "browDown" | "browUp" | "eyeWide" | "squint";
type FaceMap = Partial<Record<ShapeChannel, Target[]>>;

const SHAPE_ALIASES: Record<ShapeChannel, RegExp> = {
  blink: /^(eyeblink(left|right|l|r)?|blink(left|right|l|r|both)?|eyesclosed?|eyeclose|fcleyeclose)$/,
  smile: /^(mouthsmile(left|right|l|r)?|smile|happy|joy|fclalljoy|fun)$/,
  mouthOpen: /^(jawopen|mouthopen|visemeaa|aa|fclmtha|a)$/,
  mouthRound: /^(visemeo|visemeou|oh|ou|fclmtho|o|mouthfunnel)$/,
  frown: /^(mouthfrown(left|right|l|r)?|frown|sad|sorrow|fclallsorrow)$/,
  browDown: /^(browdown(left|right|l|r)?|angry|mad|fclallangry)$/,
  browUp: /^(browinnerup|browouterup(left|right|l|r)?|browup|surprised?|fclallsurprised)$/,
  eyeWide: /^(eyewide(left|right|l|r)?|eyeswide)$/,
  squint: /^(eyesquint(left|right|l|r)?|squint)$/,
};

/** Plain-letters key for a blend-shape name. Exported for tests. */
export const shapeKey = (name: string) => name.toLowerCase().replace(/[^a-z]/g, "");

/** Which face channel a blend-shape name drives, if any. Exported for tests. */
export function channelForShape(name: string): ShapeChannel | null {
  const key = shapeKey(name);
  for (const [channel, pattern] of Object.entries(SHAPE_ALIASES)) if (pattern.test(key)) return channel as ShapeChannel;
  return null;
}

/** Name parts that say nothing about a bone's role. */
const NOISE = new Set(["mixamorig", "j", "bip", "c", "def", "drv", "jnt", "bone", "b"]);

/** Role and side tokens for a bone name. Exported for tests. */
export function boneKey(name: string) {
  const tokens = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((token) => token && !/^\d+$/.test(token) && !NOISE.has(token));
  const ignored = tokens.some((token) => token === "end" || token === "nub" || token === "top");
  const base = tokens.filter((token) => !["l", "r", "left", "right"].includes(token)).join("");
  return { base, ignored };
}

const ROLE_NAMES: Record<string, string[]> = {
  spine: ["spine"],
  chest: ["upperchest", "chest", "spine2", "spine1"],
  neck: ["neck"],
  head: ["head"],
  eyes: ["eye"],
  upperArm: ["upperarm", "arm"],
  lowerArm: ["lowerarm", "forearm"],
};

type BoneEntry = { bone: Object3D; mirror: boolean; base: Quaternion; applied: Quaternion | null };

const BUILT_IN_BONES = ["Head_09", "Eye_L_018", "Eye_R_019"];

function isNumericDictionary(dictionary: Record<string, number>) {
  return Object.keys(dictionary).every((name) => /^\d+$/.test(name));
}

function mapFace(root: Object3D) {
  const face: FaceMap = {};
  let builtIn = false;
  const builtInRig = BUILT_IN_BONES.every((name) => root.getObjectByName(name));
  root.traverse((object) => {
    const mesh = object as Mesh;
    const dictionary = mesh.morphTargetDictionary;
    if (!dictionary || !mesh.morphTargetInfluences?.length) return;
    mesh.morphTargetInfluences.fill(0);
    if (builtInRig && isNumericDictionary(dictionary) && mesh.morphTargetInfluences.length === 2) {
      // The bundled avatar: shape 0 closes the eyes, shape 1 is its "^^" smile.
      builtIn = true;
      (face.blink ??= []).push({ mesh, index: 0 });
      (face.smile ??= []).push({ mesh, index: 1 });
      return;
    }
    for (const [name, index] of Object.entries(dictionary)) {
      const channel = channelForShape(name);
      if (channel) (face[channel] ??= []).push({ mesh, index });
    }
  });
  return { face, builtIn };
}

function isDescendant(child: Object3D, ancestor: Object3D) {
  for (let node = child.parent; node; node = node.parent) if (node === ancestor) return true;
  return false;
}

function mapBones(root: Object3D) {
  const found: Record<string, Object3D[]> = {};
  root.traverse((object) => {
    if (!(object as { isBone?: boolean }).isBone) return;
    const { base, ignored } = boneKey(object.name);
    if (ignored) return;
    for (const [role, names] of Object.entries(ROLE_NAMES)) {
      const rank = names.indexOf(base);
      if (rank >= 0) (found[`${role}:${rank}`] ??= []).push(object);
    }
  });
  const pick = (role: string) => {
    for (let rank = 0; rank < ROLE_NAMES[role].length; rank += 1) if (found[`${role}:${rank}`]?.length) return found[`${role}:${rank}`];
    return [];
  };

  root.updateMatrixWorld(true);
  const sideOf = (bone: Object3D) => root.worldToLocal(bone.getWorldPosition(new Vector3())).x;
  const bones = new Map<BoneRole, BoneEntry[]>();
  const entry = (bone: Object3D, mirror = false): BoneEntry => ({ bone, mirror, base: bone.quaternion.clone(), applied: null });
  const single = (role: BoneRole, candidates: Object3D[]) => { if (candidates[0]) bones.set(role, [entry(candidates[0])]); };

  single("spine", pick("spine"));
  const spine = bones.get("spine")?.[0]?.bone;
  single("chest", pick("chest").filter((bone) => bone !== spine));
  single("neck", pick("neck"));
  single("head", pick("head"));
  const eyes = pick("eyes");
  if (eyes.length) bones.set("eyes", eyes.map((bone) => entry(bone)));

  const lowers = pick("lowerArm");
  for (const upper of pick("upperArm")) {
    const lower = lowers.find((candidate) => isDescendant(candidate, upper));
    if (!lower) continue;
    const isA = sideOf(upper) > 0;
    const suffix = isA ? "A" : "B";
    if (bones.has(`upperArm${suffix}` as BoneRole)) continue;
    bones.set(`upperArm${suffix}` as BoneRole, [entry(upper, !isA)]);
    bones.set(`lowerArm${suffix}` as BoneRole, [entry(lower, !isA)]);
  }
  return bones;
}

function mouthTexture() {
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return null;
  canvas.width = 128;
  canvas.height = 96;
  context.fillStyle = "#5b1726";
  context.beginPath();
  context.ellipse(64, 48, 58, 42, 0, 0, Math.PI * 2);
  context.fill();
  context.save();
  context.clip();
  context.fillStyle = "#d9707f";
  context.beginPath();
  context.ellipse(64, 92, 46, 30, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = "srgb";
  return texture;
}

type MouthOverlay = { mesh: Mesh; width: number; dispose: () => void };

/**
 * The bundled model's mouth is painted on, with no open-mouth shape. For
 * talking and surprise, place a small mouth on the face, attached to the head
 * so it follows every movement, and size it from where the smile shape moves
 * the mouth corners.
 */
function buildMouthOverlay(root: Object3D, smile: Target[], head: Object3D | undefined): MouthOverlay | null {
  const mesh = smile.map((target) => target.mesh).find((candidate) => {
    const materials = Array.isArray(candidate.material) ? candidate.material : [candidate.material];
    return materials.some((material) => /face/i.test(material.name));
  }) ?? smile[0]?.mesh;
  const shape = mesh?.geometry.morphAttributes.position?.[smile.find((target) => target.mesh === mesh)?.index ?? 1];
  if (!mesh || !shape || !head) return null;

  root.updateMatrixWorld(true);
  const points: Vector3[] = [];
  const point = new Vector3();
  for (let index = 0; index < shape.count; index += 1) {
    if (Math.hypot(shape.getX(index), shape.getY(index), shape.getZ(index)) < 0.003) continue;
    if (mesh instanceof SkinnedMesh) mesh.getVertexPosition(index, point);
    else point.fromBufferAttribute(mesh.geometry.getAttribute("position"), index);
    points.push(root.worldToLocal(mesh.localToWorld(point.clone())));
  }
  if (points.length < 8) return null;
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const mouth = points.filter((p) => p.y <= minY + (maxY - minY) * 0.12);
  const minX = Math.min(...mouth.map((p) => p.x));
  const maxX = Math.max(...mouth.map((p) => p.x));
  const width = maxX - minX;
  if (!(width > 0)) return null;
  const center = new Vector3((minX + maxX) / 2, mouth.reduce((sum, p) => sum + p.y, 0) / mouth.length, Math.max(...mouth.map((p) => p.z)) + width * 0.04);

  const texture = mouthTexture();
  const material = new MeshBasicMaterial({ color: texture ? 0xffffff : 0x5b1726, map: texture, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 });
  const geometry = new PlaneGeometry(1, 1);
  const overlay = new Mesh(geometry, material);
  overlay.name = "HannahMouth";
  overlay.renderOrder = 5;
  overlay.visible = false;
  head.add(overlay);

  // Express the overlay in the head's space: model-space position, facing the model's front.
  const rootQuaternion = root.getWorldQuaternion(new Quaternion());
  overlay.position.copy(head.worldToLocal(root.localToWorld(center.clone())));
  overlay.quaternion.copy(head.getWorldQuaternion(new Quaternion()).invert().multiply(rootQuaternion));
  const headScale = head.getWorldScale(new Vector3()).x / root.getWorldScale(new Vector3()).x || 1;
  return {
    mesh: overlay,
    width: width / headScale,
    dispose() {
      overlay.removeFromParent();
      geometry.dispose();
      material.dispose();
      texture?.dispose();
    },
  };
}

export type AvatarRigState = {
  emotion: Emotion;
  activity: AvatarActivity;
  /** Pointer position over the avatar, −1..1 on each axis (y up), or null. */
  lookAt: { x: number; y: number } | null;
  reducedMotion: boolean;
};

export type AvatarRig = {
  /** Advance by `delta` seconds at clock `time`. Returns the vertical hop (0..~1.5) for the scene to apply. */
  update(delta: number, time: number, state: AvatarRigState): { bounce: number };
  trigger(gesture: Gesture): void;
  readonly capabilities: { face: string[]; bones: string[]; mouth: "shape" | "overlay" | "none" };
  dispose(): void;
};

export function createAvatarRig(root: Object3D, { random = Math.random, greet = true }: { random?: () => number; greet?: boolean } = {}): AvatarRig {
  const { face, builtIn } = mapFace(root);
  const bones = mapBones(root);
  const overlay = !face.mouthOpen?.length && builtIn && face.smile ? buildMouthOverlay(root, face.smile, bones.get("head")?.[0]?.bone) : null;
  const blinker = new BlinkScheduler(random);
  const current = emptyPose();
  let lastEmotion: Emotion | null = null;
  let gesture: { name: Gesture; started: number } | null = null;
  let pendingGesture: Gesture | null = greet ? "wave" : null;
  const greetAt = 1.1;
  let glance: { until: number; y: number; next: number } = { until: 0, y: 0, next: 6 + random() * 5 };
  let clock = 0;

  const rootQuaternion = new Quaternion();
  const parentQuaternion = new Quaternion();
  const parentInModel = new Quaternion();
  const rotation = new Quaternion();
  const euler = new Euler(0, 0, 0, "YXZ");

  const setShape = (channel: ShapeChannel, value: number) => {
    for (const { mesh, index } of face[channel] ?? []) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = value;
  };

  const applyBones = (pose: PoseVector) => {
    root.getWorldQuaternion(rootQuaternion).invert();
    for (const role of BONE_ROLES) {
      for (const entry of bones.get(role) ?? []) {
        const { bone } = entry;
        // Bones the idle clip doesn't animate keep last frame's offset; undo it first.
        if (entry.applied && bone.quaternion.equals(entry.applied)) bone.quaternion.copy(entry.base);
        entry.base.copy(bone.quaternion);
        const sign = entry.mirror ? -1 : 1;
        const x = pose[`${role}.x`] ?? 0, y = (pose[`${role}.y`] ?? 0) * sign, z = (pose[`${role}.z`] ?? 0) * sign;
        if (bone.parent && (Math.abs(x) + Math.abs(y) + Math.abs(z)) > 1e-5) {
          bone.parent.getWorldQuaternion(parentQuaternion);
          parentInModel.copy(rootQuaternion).multiply(parentQuaternion);
          rotation.setFromEuler(euler.set(x, y, z, "YXZ"));
          // Rotate in model space: L' = P⁻¹ · R · P · L
          rotation.premultiply(parentInModel.clone().invert()).multiply(parentInModel);
          bone.quaternion.premultiply(rotation);
        }
        entry.applied = (entry.applied ?? new Quaternion()).copy(bone.quaternion);
      }
    }
  };

  return {
    capabilities: {
      face: Object.keys(face),
      bones: [...bones.keys()],
      mouth: face.mouthOpen?.length ? "shape" : overlay ? "overlay" : "none",
    },
    trigger(name) {
      gesture = { name, started: clock };
    },
    update(rawDelta, time, state) {
      const delta = Math.min(Math.max(rawDelta, 0), 0.1);
      clock = time;
      const motion = state.reducedMotion ? 0.3 : 1;

      if (lastEmotion !== null && state.emotion !== lastEmotion) {
        const next = gestureForEmotion(state.emotion);
        if (next) gesture = { name: next, started: time };
      }
      lastEmotion = state.emotion;
      if (pendingGesture && time >= greetAt) {
        if (!gesture) gesture = { name: pendingGesture, started: time };
        pendingGesture = null;
      }
      if (gesture && time - gesture.started >= GESTURE_DURATION[gesture.name]) gesture = null;

      const target = targetPose(state.emotion, state.activity);
      const life = lifeMotion(time, motion * (state.activity === "thinking" ? 0.6 : 1));
      for (const [key, value] of Object.entries(life)) target[key] += value;

      if (state.lookAt) {
        target["head.y"] += state.lookAt.x * 0.24;
        target["head.x"] -= state.lookAt.y * 0.14;
        target["eyes.y"] += state.lookAt.x * 0.3;
        target["eyes.x"] -= state.lookAt.y * 0.2;
        glance.next = time + 4;
      } else if (state.activity === "idle" && !gesture) {
        if (time >= glance.next) glance = { until: time + 1.7, y: (random() < 0.5 ? -1 : 1) * (0.12 + random() * 0.1), next: time + 7 + random() * 6 };
        if (time < glance.until) {
          target["head.y"] += glance.y;
          target["eyes.y"] += glance.y * 1.4;
        }
      }
      if (state.activity === "thinking") {
        target["eyes.y"] += 0.12 * Math.sin(time * 0.9);
      }
      if (state.activity === "speaking") {
        const talk = talkOpenness(time);
        target["face.mouthOpen"] = Math.max(target["face.mouthOpen"], 0.15 + talk * 0.85);
        target["face.mouthRound"] = 0.25 + 0.35 * Math.max(0, Math.sin(time * 2.3));
        target["head.x"] += 0.035 * talk * motion;
        target["lowerArmA.x"] -= 0.08 * talk * motion;
        target["lowerArmB.x"] -= 0.05 * Math.max(0, Math.sin(time * 1.9)) * motion;
      }
      if (state.reducedMotion) target.bounce = 0;

      // The mouth moves at speech speed; everything else eases.
      const mouthKeys = ["face.mouthOpen", "face.mouthRound"];
      const slow: PoseVector = {};
      const fast: PoseVector = {};
      for (const [key, value] of Object.entries(target)) (mouthKeys.includes(key) ? fast : slow)[key] = value;
      dampPose(current, slow, 6.5, delta);
      dampPose(current, fast, 22, delta);

      const final: PoseVector = { ...current };
      if (gesture) {
        const scale = state.reducedMotion ? 0.3 : 1;
        for (const [key, value] of Object.entries(gesturePose(gesture.name, time - gesture.started))) {
          final[key] = (final[key] ?? 0) + value * (key.startsWith("face.") ? 1 : scale);
        }
      }

      applyBones(final);

      // The bundled model's smile shape holds up past 1 (a fang grin); others stop at 1.
      const smile = Math.min(builtIn ? 1.35 : 1, Math.max(0, final["face.smile"]));
      const blink = blinker.value(time);
      const baseLid = Math.max(-0.4, Math.min(1, final["face.lid"]));
      const lid = Math.max(-0.4, Math.min(1, baseLid + blink * (1 - Math.max(0, baseLid)) * (1 - Math.min(1, smile) * 0.85)));
      setShape("smile", smile);
      if (builtIn) setShape("blink", lid);
      else {
        setShape("blink", Math.max(0, lid));
        setShape("eyeWide", Math.max(0, -lid) / 0.4);
        setShape("squint", Math.max(0, baseLid) * 0.5);
      }
      setShape("frown", Math.max(0, final["face.frown"]));
      setShape("browDown", Math.max(0, final["face.browDown"]));
      setShape("browUp", Math.max(0, final["face.browUp"]));

      const open = Math.min(1, Math.max(0, final["face.mouthOpen"]));
      const round = Math.min(1, Math.max(0, final["face.mouthRound"]));
      setShape("mouthOpen", open * (1 - round * 0.4));
      setShape("mouthRound", open * round);
      if (overlay) {
        overlay.mesh.visible = open > 0.05;
        const width = overlay.width * (0.5 - round * 0.18) * (0.75 + open * 0.25);
        overlay.mesh.scale.set(width, overlay.width * 0.42 * open * (1 + round * 0.25), 1);
      }
      return { bounce: final.bounce ?? 0 };
    },
    dispose() {
      overlay?.dispose();
      for (const entries of bones.values()) for (const entry of entries) if (entry.applied) entry.bone.quaternion.copy(entry.base);
      for (const targets of Object.values(face)) for (const { mesh } of targets ?? []) mesh.morphTargetInfluences?.fill(0);
    },
  };
}

export type { AvatarActivity, Gesture } from "./expressions";
