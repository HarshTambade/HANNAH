import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useAnimations, useGLTF, useProgress } from "@react-three/drei";
import { AnimationClip, Box3, BufferGeometry, Group, Material, MathUtils, Mesh, PerspectiveCamera, SkinnedMesh, Texture, Vector3 } from "three";
import { DRACOLoader, SkeletonUtils } from "three-stdlib";
import type { Emotion } from "../types";
import { createAvatarRig, type AvatarActivity, type AvatarRig } from "../services/avatar/AvatarRig";
import { repairMorphTargets } from "../services/avatar/morphRepair";

export type { AvatarActivity } from "../services/avatar/AvatarRig";

const emotionLight: Record<Emotion, string> = {
  happy: "#fbbf24",
  sad: "#60a5fa",
  angry: "#fb7185",
  neutral: "#a78bfa",
  surprised: "#fb923c",
  thinking: "#c084fc",
};

const dracoLoader = new DRACOLoader();
const publicBaseUrl = import.meta.env.BASE_URL;
dracoLoader.setDecoderPath(`${publicBaseUrl}draco/`);
const configuredAvatarModelUrl = import.meta.env.VITE_AVATAR_MODEL_URL?.trim();
// The Draco-compressed model (2.6 MB instead of 7.4 MB, decoded in a worker) unless a build chooses another.
const avatarModelUrl = configuredAvatarModelUrl || `${publicBaseUrl}models/avatar.draco.glb`;
const uncompressedAvatarModelUrl = `${publicBaseUrl}models/avatar.glb`;
const cachedSceneUsers = new WeakMap<Group, number>();

export type AvatarMotion = "loading" | "animation" | "procedural" | "error";

class AvatarLoadBoundary extends Component<{
  children: ReactNode;
  fallback: ReactNode;
  onError?: () => void;
}, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch() {
    this.props.onError?.();
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function cloneAvatarResources(scene: Group) {
  // useGLTF caches its scene globally. Give the mounted instance independent
  // GPU resources; cleanup can then dispose these without touching that cache.
  const geometries = new Map<BufferGeometry, BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Map<Texture, Texture>();
  const skeletonTextures = new Set<Texture>();
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const skeletonTexture = (object as Mesh & { skeleton?: { boneTexture?: Texture } }).skeleton?.boneTexture;
    if (skeletonTexture) skeletonTextures.add(skeletonTexture);
    let geometry = geometries.get(object.geometry);
    if (!geometry) {
      const clone = object.geometry.clone();
      // Fix blend shapes exported in the wrong units before anything renders them.
      repairMorphTargets(clone);
      geometries.set(object.geometry, clone);
      geometry = clone;
    }
    object.geometry = geometry;
    if (object.morphTargetInfluences) object.updateMorphTargets();

    const cloneMaterial = (material: Material) => {
      const clone = material.clone();
      materials.add(clone);
      for (const [key, value] of Object.entries(clone as unknown as Record<string, unknown>)) {
        if (!(value instanceof Texture)) continue;
        let texture = textures.get(value);
        if (!texture) {
          texture = value.clone();
          texture.needsUpdate = true;
          textures.set(value, texture);
        }
        (clone as unknown as Record<string, unknown>)[key] = texture;
      }
      return clone;
    };
    object.material = Array.isArray(object.material)
      ? object.material.map(cloneMaterial)
      : cloneMaterial(object.material);
  });

  return {
    dispose() {
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
      skeletonTextures.forEach((texture) => texture.dispose());
    },
  };
}

function retainCachedAvatarScene(modelUrl: string, scene: Group) {
  cachedSceneUsers.set(scene, (cachedSceneUsers.get(scene) ?? 0) + 1);
  return () => {
    const users = cachedSceneUsers.get(scene) ?? 1;
    if (users > 1) {
      cachedSceneUsers.set(scene, users - 1);
      return;
    }
    cachedSceneUsers.delete(scene);
    // Defer cache release by one task so React StrictMode's development-only
    // mount/cleanup/remount cycle can reclaim the scene before it is disposed.
    setTimeout(() => {
      if (cachedSceneUsers.has(scene)) return;
      useGLTF.clear(modelUrl);
      const geometries = new Set<BufferGeometry>();
      const materials = new Set<Material>();
      const textures = new Set<Texture>();
      scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        geometries.add(object.geometry);
        const skeletonTexture = (object as Mesh & { skeleton?: { boneTexture?: Texture } }).skeleton?.boneTexture;
        if (skeletonTexture) textures.add(skeletonTexture);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          materials.add(material);
          for (const value of Object.values(material as unknown as Record<string, unknown>)) {
            if (value instanceof Texture) textures.add(value);
          }
        }
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
    }, 0);
  };
}

type PointerState = { x: number; y: number; at: number } | null;

function Avatar({ emotion, activity, pointer, pokes, reducedMotion, onMotionChange, modelUrl }: {
  emotion: Emotion;
  activity: AvatarActivity;
  pointer: MutableRefObject<PointerState>;
  pokes: MutableRefObject<number>;
  reducedMotion: boolean;
  onMotionChange?: (motion: AvatarMotion) => void;
  modelUrl: string;
}) {
  const { scene, animations } = useGLTF(modelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
  // Keep the render-time clone CPU-only; clone GPU resources in the effect so
  // StrictMode's intentional double render cannot leak discarded resources.
  const avatar = useMemo(() => SkeletonUtils.clone(scene) as Group, [scene]);
  const group = useRef<Group>(null);
  const model = useRef<Group>(null);
  const modelScaleInitialized = useRef(false);
  const rig = useRef<AvatarRig | null>(null);
  const handledPokes = useRef(pokes.current);
  const stableAnimations = useMemo(() => animations.map((animation) => {
    // The GLB's Idle clip animates all three face morph meshes plus the eye,
    // head, and neck tracks. Those keys make the facial features disappear at
    // some frames, so keep the body/hair/clothing motion and hold the face still.
    const tracks = animation.tracks.filter(({ name }) => {
      const trackName = name.toLowerCase();
      return !trackName.includes("morphtargetinfluences")
        && !/^(head_09|neck_08|eye_l_018|eye_r_019)\./.test(trackName);
    });
    return tracks.length === animation.tracks.length
      ? animation
      : new AnimationClip(animation.name, animation.duration, tracks, animation.blendMode);
  }), [animations]);
  const { actions } = useAnimations(stableAnimations, group);
  const { camera, size } = useThree();

  useEffect(() => retainCachedAvatarScene(modelUrl, scene), [modelUrl, scene]);

  useEffect(() => {
    return cloneAvatarResources(avatar).dispose;
  }, [avatar]);

  // After the resources above are cloned and repaired: expressions, blinking,
  // talking, gaze, and gestures on top of the idle clip.
  useEffect(() => {
    const instance = createAvatarRig(avatar, { greet: !reducedMotion });
    rig.current = instance;
    return () => {
      instance.dispose();
      if (rig.current === instance) rig.current = null;
    };
  }, [avatar, reducedMotion]);

  const framing = useMemo(() => {
    // Include deformed skin vertices: the GLB's undeformed geometry bounds are
    // much smaller than the visible character and crop the head when fitted.
    avatar.updateMatrixWorld(true);
    avatar.traverse((object) => {
      if ((object as SkinnedMesh).isSkinnedMesh) (object as SkinnedMesh).skeleton.update();
    });
    const bounds = new Box3().setFromObject(avatar, true);
    const modelSize = bounds.getSize(new Vector3());
    const center = bounds.getCenter(new Vector3());
    return {
      sourceHeight: modelSize.y,
      sourceWidth: modelSize.x,
      position: [-center.x, -bounds.min.y, -center.z] as [number, number, number],
    };
  }, [avatar]);

  useEffect(() => {
    const idleAnimation = stableAnimations.find((animation) => /idle|stand|breath/i.test(animation.name)) ?? stableAnimations[0];
    const firstAction = idleAnimation ? actions[idleAnimation.name] : undefined;
    firstAction?.reset().fadeIn(0.5).play();
    onMotionChange?.(firstAction ? "animation" : "procedural");
    return () => {
      firstAction?.fadeOut(0.25);
    };
  }, [actions, stableAnimations, onMotionChange]);

  useFrame(({ clock }, delta) => {
    if (!group.current) return;

    const time = clock.elapsedTime;
    if (rig.current && pokes.current !== handledPokes.current) {
      handledPokes.current = pokes.current;
      rig.current.trigger("giggle");
    }
    const recentPointer = pointer.current && performance.now() - pointer.current.at < 4000 ? pointer.current : null;
    const { bounce } = rig.current?.update(delta, time, { emotion, activity, lookAt: recentPointer, reducedMotion }) ?? { bounce: 0 };
    const avatar = group.current;
    const modelGroup = model.current;
    const perspectiveCamera = camera as PerspectiveCamera;
    const viewHeight = 2 * 5.4 * Math.tan((perspectiveCamera.fov * Math.PI) / 360);
    const aspect = size.width / Math.max(1, size.height);
    const viewWidth = viewHeight * aspect;
    // Leave a generous margin: skinned hair, clothing, and idle motion can extend
    // beyond the static pose bounds, so fitting right to the edge clips the model.
    const heightFraction = 0.76;
    const heightLimit = viewHeight * heightFraction;
    const widthLimit = viewWidth * 0.78 * (framing.sourceHeight / Math.max(framing.sourceWidth, 0.001));
    const fitScale = Math.min(heightLimit, widthLimit) / Math.max(framing.sourceHeight, 0.001);
    // Keep the character's center fixed. The previous lateral sway and broad
    // yaw made this tall model appear to travel across the entire stage.
    avatar.position.x = 0;
    const fittedAvatarHeight = fitScale * framing.sourceHeight;
    // The rig moves the head, body, and arms; the whole figure only bobs gently
    // and hops a little when a happy or surprised moment calls for it.
    const motion = reducedMotion ? 0.3 : 1;
    const hop = bounce * 0.11 * Math.max(0, Math.sin(time * Math.PI * 2 * 1.3));
    avatar.position.y = 1.1 - fittedAvatarHeight / 2 + Math.sin(time * 1.25) * 0.03 * motion + hop;
    avatar.rotation.x = MathUtils.damp(avatar.rotation.x, 0, 3.5, delta);
    avatar.rotation.y = MathUtils.damp(avatar.rotation.y, Math.sin(time * 0.34) * 0.025 * motion, 2.8, delta);
    avatar.rotation.z = MathUtils.damp(avatar.rotation.z, 0, 3.5, delta);

    if (modelGroup) {
      // The source model has a large off-origin transform. Apply its centering
      // offset in the same scaled coordinate space, or the avatar lands far
      // outside the camera frustum while its animation still appears active.
      modelGroup.position.set(
        framing.position[0] * fitScale,
        framing.position[1] * fitScale,
        framing.position[2] * fitScale,
      );
      const breath = Math.sin(time * 1.8) * 0.016;
      const nextX = fitScale * (1 + breath * 0.5);
      const nextY = fitScale * (1 + breath);
      const nextZ = fitScale * (1 + breath * 0.5);
      if (!modelScaleInitialized.current) {
        modelGroup.scale.set(nextX, nextY, nextZ);
        modelScaleInitialized.current = true;
      } else {
        modelGroup.scale.x = MathUtils.damp(modelGroup.scale.x, nextX, 4, delta);
        modelGroup.scale.y = MathUtils.damp(modelGroup.scale.y, nextY, 4, delta);
        modelGroup.scale.z = MathUtils.damp(modelGroup.scale.z, nextZ, 4, delta);
      }
    }
  });

  return (
    <group ref={group}>
      <group ref={model}>
        <primitive object={avatar} dispose={null} />
      </group>
    </group>
  );
}

// The loading and error overlays are ordinary page elements drawn over the
// canvas, not drei <Html> inside the scene. <Html> runs its own React root in a
// container the canvas owns; when the avatar unmounted (leaving the landing
// page for chat) the canvas removed that container first, React then failed to
// remove the overlay, and the whole app fell back to its crash screen.

/** Mounted inside the scene while the model loads (the Suspense fallback). */
function LoadingSignal({ onChange }: { onChange: (loading: boolean) => void }) {
  useEffect(() => {
    onChange(true);
    return () => onChange(false);
  }, [onChange]);
  return null;
}

/** Mounted inside the scene when the model failed to load. */
function ErrorSignal({ onFailed, onMotionChange }: { onFailed: () => void; onMotionChange?: (motion: AvatarMotion) => void }) {
  useEffect(() => {
    onFailed();
    onMotionChange?.("error");
  }, [onFailed, onMotionChange]);
  return null;
}

function LoadingOverlay() {
  const { progress } = useProgress();
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center" role="status" aria-live="polite">
      <div className="w-44 text-center">
        <div className="mx-auto mb-3 h-1 w-36 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-violet-400 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-slate-400">Preparing your space · {Math.round(progress)}%</p>
      </div>
    </div>
  );
}

function ErrorOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center" role="alert">
      <div className="w-64 rounded-xl border border-rose-300/15 bg-[#0c101b]/90 px-4 py-3 text-center shadow-xl">
        <p className="text-xs font-semibold text-slate-200">Avatar could not be displayed</p>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-400">Refresh the page to try loading the model again.</p>
      </div>
    </div>
  );
}

function usePrefersReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export default function AvatarScene({ emotion, activity = "idle", onMotionChange }: {
  emotion: Emotion;
  /** What HANNAH is doing right now: she leans in to listen, thinks with a hand to her cheek, and talks. */
  activity?: AvatarActivity;
  onMotionChange?: (motion: AvatarMotion) => void;
}) {
  const [useUncompressedModel, setUseUncompressedModel] = useState(false);
  const canFallback = !configuredAvatarModelUrl && avatarModelUrl !== uncompressedAvatarModelUrl;
  const modelUrl = useUncompressedModel ? uncompressedAvatarModelUrl : avatarModelUrl;
  const container = useRef<HTMLDivElement>(null);
  const pointer = useRef<PointerState>(null);
  const pokes = useRef(0);
  const reducedMotion = usePrefersReducedMotion();
  // Shown only while the scene is waiting for the model (a cached model may never wait).
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const markFailed = useCallback(() => setFailed(true), []);
  const retrying = canFallback && !useUncompressedModel;
  // Trying the uncompressed model after the compressed one failed starts over.
  useEffect(() => { setFailed(false); }, [modelUrl]);

  // She follows the pointer with her head and eyes, measured from her face
  // (about a third of the way down the stage).
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const box = container.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return;
      const clamp = (value: number) => Math.max(-1, Math.min(1, value));
      pointer.current = {
        x: clamp((event.clientX - (box.left + box.width / 2)) / Math.max(box.width, 320)),
        y: clamp(-(event.clientY - (box.top + box.height * 0.32)) / Math.max(box.height, 320)),
        at: performance.now(),
      };
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  return (
    <div
      ref={container}
      className="relative h-full w-full"
      data-emotion={emotion}
      data-activity={activity}
      onPointerDown={() => { pokes.current += 1; }}
      role="img"
      aria-label={`HANNAH avatar showing ${emotion} expression`}
    >
      <Canvas
        camera={{ position: [0, 1.1, 5.4], fov: 35 }}
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
        onCreated={({ gl, camera }) => {
          gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
          gl.setClearColor("#000000", 0);
          camera.position.set(0, 1.1, 5.4);
          camera.lookAt(0, 1.1, 0);
          camera.updateProjectionMatrix();
        }}
      >
        <ambientLight intensity={1.8} />
        <directionalLight position={[3, 5, 4]} intensity={3.1} color="#fff2df" />
        <directionalLight position={[-4, 2, -3]} intensity={2.2} color="#a6a5ff" />
        <pointLight position={[0, 1.8, 2.5]} intensity={0.95} color={emotionLight[emotion]} />
        <AvatarLoadBoundary
          key={modelUrl}
          onError={canFallback && !useUncompressedModel ? () => setUseUncompressedModel(true) : undefined}
          fallback={<ErrorSignal onFailed={markFailed} onMotionChange={onMotionChange} />}
        >
          <Suspense fallback={<LoadingSignal onChange={setLoading} />}>
            <Avatar emotion={emotion} activity={activity} pointer={pointer} pokes={pokes} reducedMotion={reducedMotion} onMotionChange={onMotionChange} modelUrl={modelUrl} />
          </Suspense>
        </AvatarLoadBoundary>
      </Canvas>
      {failed && !retrying ? <ErrorOverlay /> : loading ? <LoadingOverlay /> : null}
    </div>
  );
}

useGLTF.preload(avatarModelUrl, false, false, (loader) => loader.setDRACOLoader(dracoLoader));
