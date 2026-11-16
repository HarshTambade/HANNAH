import { describe, expect, it } from "vitest";
import { Bone, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial } from "three";
import { repairMorphTargets } from "../services/avatar/morphRepair";
import {
  BlinkScheduler, dampPose, emptyPose, envelope, GESTURE_DURATION, gestureForEmotion, gesturePose, talkOpenness, targetPose,
} from "../services/avatar/expressions";
import { boneKey, channelForShape, createAvatarRig } from "../services/avatar/AvatarRig";

/** A small "face": 60 points around y = 9 (like the bundled model's head), with a delta that moves only a few. */
function faceGeometry(encode: (base: number, delta: number) => number) {
  const base: number[] = [];
  const target: number[] = [];
  for (let index = 0; index < 60; index += 1) {
    const x = (index % 10) / 10 - 0.5, y = 8.5 + Math.floor(index / 10) / 6, z = 0.5;
    const moves = index >= 40 && index < 50;
    const delta = [0, moves ? -0.08 : 0, moves ? 0.01 : 0];
    [x, y, z].forEach((value, axis) => {
      base.push(value);
      target.push(encode(value, delta[axis]));
    });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(base, 3));
  geometry.morphAttributes.position = [new Float32BufferAttribute(target, 3)];
  geometry.morphAttributes.normal = [new Float32BufferAttribute(new Array(target.length).fill(50), 3)];
  geometry.morphTargetsRelative = true;
  return geometry;
}

describe("repairMorphTargets", () => {
  it("recovers deltas exported as (base + delta) × 100 − base", () => {
    const geometry = faceGeometry((base, delta) => (base + delta) * 100 - base);
    expect(repairMorphTargets(geometry)).toBe("repaired");
    const target = geometry.morphAttributes.position[0];
    expect(target.getY(45)).toBeCloseTo(-0.08, 4);
    expect(target.getZ(45)).toBeCloseTo(0.01, 4);
    expect(target.getY(5)).toBeCloseTo(0, 4);
    expect(geometry.morphAttributes.normal).toBeUndefined();
    // Running it again on repaired data changes nothing.
    expect(repairMorphTargets(geometry)).toBe("ok");
  });

  it("leaves correct blend shapes alone", () => {
    const geometry = faceGeometry((_base, delta) => delta);
    expect(repairMorphTargets(geometry)).toBe("ok");
    expect(geometry.morphAttributes.position[0].getY(45)).toBeCloseTo(-0.08, 5);
  });

  it("drops shapes that can't be recovered instead of letting the face fly away", () => {
    const geometry = faceGeometry((_base, _delta) => 5000 + Math.random() * 3000);
    expect(repairMorphTargets(geometry)).toBe("dropped");
    expect(geometry.morphAttributes.position).toBeUndefined();
  });

  it("does nothing without blend shapes", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0], 3));
    expect(repairMorphTargets(geometry)).toBe("none");
  });
});

describe("avatar expressions", () => {
  it("gives each emotion a distinct face", () => {
    expect(targetPose("happy", "idle")["face.smile"]).toBeGreaterThan(targetPose("neutral", "idle")["face.smile"]);
    expect(targetPose("sad", "idle")["head.x"]).toBeGreaterThan(0.15);
    expect(targetPose("surprised", "idle")["face.lid"]).toBeLessThan(0);
    expect(targetPose("angry", "idle")["face.browDown"]).toBe(1);
  });

  it("keeps the emotion's face while the activity takes over the body", () => {
    const sadThinking = targetPose("sad", "thinking");
    expect(sadThinking["lowerArmA.x"]).toBeCloseTo(targetPose("thinking", "idle")["lowerArmA.x"], 5);
    expect(sadThinking["face.lid"]).toBeGreaterThan(0.2);
    expect(targetPose("neutral", "listening")["head.z"]).toBeGreaterThan(targetPose("neutral", "idle")["head.z"]);
  });

  it("starts and ends every gesture at rest", () => {
    for (const gesture of Object.keys(GESTURE_DURATION) as (keyof typeof GESTURE_DURATION)[]) {
      for (const t of [0, GESTURE_DURATION[gesture]]) {
        for (const value of Object.values(gesturePose(gesture, t))) expect(Math.abs(value)).toBeLessThan(1e-6);
      }
      const middle = gesturePose(gesture, GESTURE_DURATION[gesture] / 2);
      expect(Object.values(middle).some((value) => Math.abs(value) > 0.01)).toBe(true);
    }
    expect(gestureForEmotion("happy")).toBe("wave");
    expect(gestureForEmotion("neutral")).toBeNull();
    expect(envelope(0.5, 1, 0.2, 0.2)).toBe(1);
  });

  it("talks at speech rate with pauses between phrases", () => {
    const samples = Array.from({ length: 1200 }, (_, index) => talkOpenness(index / 60));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
    expect(samples.reduce((sum, value) => sum + value, 0) / samples.length).toBeGreaterThan(0.12);
    // Count mouth openings over 20 seconds: a few per second, not a flicker.
    let openings = 0;
    for (let index = 1; index < samples.length; index += 1) if (samples[index - 1] < 0.1 && samples[index] >= 0.1) openings += 1;
    expect(openings).toBeGreaterThan(30);
    expect(openings).toBeLessThan(120);
  });

  it("blinks briefly every few seconds", () => {
    const blinker = new BlinkScheduler(() => 0.5);
    const values = Array.from({ length: 600 }, (_, index) => blinker.value(index / 60));
    const closedFrames = values.filter((value) => value > 0.5).length;
    expect(values[0]).toBe(0);
    expect(closedFrames).toBeGreaterThan(2);
    expect(closedFrames).toBeLessThan(60);
  });

  it("eases toward the target pose", () => {
    const current = emptyPose();
    const target = { ...emptyPose(), "head.x": 0.3 };
    for (let frame = 0; frame < 120; frame += 1) dampPose(current, target, 6.5, 1 / 60);
    expect(current["head.x"]).toBeCloseTo(0.3, 2);
  });
});

describe("rig mapping", () => {
  it("recognizes common bone names", () => {
    expect(boneKey("mixamorig:LeftForeArm").base).toBe("forearm");
    expect(boneKey("Upper_Arm_R_041").base).toBe("upperarm");
    expect(boneKey("J_Bip_L_UpperArm").base).toBe("upperarm");
    expect(boneKey("Head_09").base).toBe("head");
    expect(boneKey("HeadTop_End").ignored).toBe(true);
    expect(boneKey("Eye_L_end_082").ignored).toBe(true);
  });

  it("recognizes common blend-shape names", () => {
    expect(channelForShape("eyeBlinkLeft")).toBe("blink");
    expect(channelForShape("eyeBlink_R")).toBe("blink");
    expect(channelForShape("Fcl_ALL_Joy")).toBe("smile");
    expect(channelForShape("mouthSmile_L")).toBe("smile");
    expect(channelForShape("viseme_aa")).toBe("mouthOpen");
    expect(channelForShape("jawOpen")).toBe("mouthOpen");
    expect(channelForShape("browInnerUp")).toBe("browUp");
    expect(channelForShape("Key 1")).toBeNull();
  });
});

function humanoid() {
  const root = new Group();
  const bone = (name: string, parent: Bone | Group, x: number, y: number) => {
    const next = new Bone();
    next.name = name;
    next.position.set(x, y, 0);
    parent.add(next);
    return next;
  };
  const hips = bone("mixamorig:Hips", root, 0, 1);
  const spine = bone("mixamorig:Spine", hips, 0, 0.1);
  const chest = bone("mixamorig:Spine2", spine, 0, 0.2);
  const neck = bone("mixamorig:Neck", chest, 0, 0.2);
  const head = bone("mixamorig:Head", neck, 0, 0.1);
  const rightArm = bone("mixamorig:LeftArm", chest, 0.2, 0.15); // on the viewer's right (+x)
  bone("mixamorig:LeftForeArm", rightArm, 0, -0.25);
  const leftArm = bone("mixamorig:RightArm", chest, -0.2, 0.15);
  bone("mixamorig:RightForeArm", leftArm, 0, -0.25);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], 3));
  geometry.morphAttributes.position = ["eyeBlinkLeft", "mouthSmileLeft", "jawOpen"].map((name) => {
    const attribute = new Float32BufferAttribute([0, 0.01, 0, 0, 0.01, 0, 0, 0.01, 0], 3);
    attribute.name = name;
    return attribute;
  });
  const face = new Mesh(geometry, new MeshBasicMaterial());
  head.add(face);
  root.updateMatrixWorld(true);
  return { root, head, face, rightArm };
}

describe("createAvatarRig", () => {
  const state = { activity: "idle" as const, lookAt: null, reducedMotion: false };
  const run = (rig: ReturnType<typeof createAvatarRig>, frames: number, start: number, next: Parameters<ReturnType<typeof createAvatarRig>["update"]>[2]) => {
    for (let frame = 0; frame < frames; frame += 1) rig.update(1 / 60, start + frame / 60, next);
  };

  it("maps a Mixamo-style model's face and body", () => {
    const { root } = humanoid();
    const rig = createAvatarRig(root, { random: () => 0.5, greet: false });
    expect(rig.capabilities.face).toEqual(expect.arrayContaining(["blink", "smile", "mouthOpen"]));
    expect(rig.capabilities.bones).toEqual(expect.arrayContaining(["spine", "chest", "neck", "head", "upperArmA", "lowerArmA", "upperArmB", "lowerArmB"]));
    expect(rig.capabilities.mouth).toBe("shape");
  });

  it("smiles when happy, talks when speaking, and lowers her head when sad", () => {
    const { root, head, face } = humanoid();
    const rest = head.quaternion.clone();
    const rig = createAvatarRig(root, { random: () => 0.5, greet: false });
    const influences = face.morphTargetInfluences!;

    run(rig, 120, 0, { ...state, emotion: "happy" });
    expect(influences[1]).toBeCloseTo(1, 2);

    let maxJaw = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      rig.update(1 / 60, 2 + frame / 60, { ...state, emotion: "neutral", activity: "speaking" });
      maxJaw = Math.max(maxJaw, influences[2]);
    }
    expect(maxJaw).toBeGreaterThan(0.5);

    run(rig, 180, 4, { ...state, emotion: "sad" });
    expect(head.quaternion.angleTo(rest)).toBeGreaterThan(0.15);

    rig.dispose();
    expect(head.quaternion.angleTo(rest)).toBeLessThan(1e-6);
    expect([...influences].every((value) => value === 0)).toBe(true);
  });

  it("never lets offsets pile up on bones the idle clip doesn't animate", () => {
    const { root, head } = humanoid();
    const rest = head.quaternion.clone();
    const rig = createAvatarRig(root, { random: () => 0.5, greet: false });
    let worst = 0;
    for (let frame = 0; frame < 3000; frame += 1) {
      rig.update(1 / 60, frame / 60, { ...state, emotion: "neutral" });
      worst = Math.max(worst, head.quaternion.angleTo(rest));
    }
    expect(worst).toBeLessThan(0.4);
  });

  it("waves with the arm on the viewer's right when she becomes happy", () => {
    const { root, rightArm } = humanoid();
    const rig = createAvatarRig(root, { random: () => 0.5, greet: false });
    run(rig, 60, 0, { ...state, emotion: "neutral" });
    const before = rightArm.quaternion.clone();
    run(rig, 70, 1, { ...state, emotion: "happy" });
    expect(rightArm.quaternion.angleTo(before)).toBeGreaterThan(0.6);
  });

  it("keeps working on a model with no face shapes or known bones", () => {
    const root = new Group();
    root.add(new Mesh(new BufferGeometry(), new MeshBasicMaterial()));
    const rig = createAvatarRig(root, { greet: false });
    expect(rig.capabilities).toEqual({ face: [], bones: [], mouth: "none" });
    expect(() => run(rig, 10, 0, { ...state, emotion: "angry" })).not.toThrow();
  });
});
