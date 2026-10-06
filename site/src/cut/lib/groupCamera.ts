import { cameraAt, hasCameraKeys, type CameraKey, type CameraPose, type GroupCamera } from "@donkeycut/effects-kit";
import type { Overlay } from "./types";

/**
 * A group's camera as the editor and the assistant see it: one key track in
 * seconds from the group's start. Each element member stores its own copy
 * with times from its own start (see the kit's camera.ts), so this module is
 * the one place that converts between the two clocks.
 */
export interface GroupCameraView {
  groupId: string;
  /** Timeline seconds the group's elements start and end. */
  start: number;
  end: number;
  /** Keys in seconds from `start`, in play order. */
  keys: CameraKey[];
  motionBlur?: number;
}

/** The elements a group's camera films: every member with a pose. */
export function cameraMembers(overlays: readonly Overlay[], groupId: string): Overlay[] {
  return overlays.filter((o) => o.groupId === groupId && o.kind !== "effect");
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The group's camera, read off its earliest member; null when the group has
 * no elements. A group with no camera reads as an empty track. */
export function groupCameraOf(overlays: readonly Overlay[], groupId: string): GroupCameraView | null {
  const members = cameraMembers(overlays, groupId);
  if (!members.length) return null;
  const start = Math.min(...members.map((m) => m.start));
  const end = Math.max(...members.map((m) => m.end));
  const holder = [...members].sort((a, b) => a.start - b.start).find((m) => m.camera);
  const cam = holder?.camera;
  return {
    groupId,
    start,
    end,
    keys: cam ? [...cam.kf].map((k) => ({ ...k, t: round3(k.t + holder.start - start) })).sort((a, b) => a.t - b.t) : [],
    ...(cam?.motionBlur ? { motionBlur: cam.motionBlur } : {}),
  };
}

/** Every group that carries a camera. */
export function groupCameras(overlays: readonly Overlay[]): GroupCameraView[] {
  const ids = new Set(overlays.flatMap((o) => (o.camera && o.groupId ? [o.groupId] : [])));
  return [...ids].flatMap((id) => {
    const view = groupCameraOf(overlays, id);
    return view && (view.keys.length || view.motionBlur) ? [view] : [];
  });
}

/** The overlays with the group's camera written onto every element member,
 * each on its own clock. `null`, or no keys and no motion blur, removes it. */
export function withGroupCamera(
  overlays: readonly Overlay[],
  groupId: string,
  cam: { keys: CameraKey[]; motionBlur?: number } | null
): Overlay[] {
  const members = cameraMembers(overlays, groupId);
  if (!members.length) return [...overlays];
  const start = Math.min(...members.map((m) => m.start));
  const ids = new Set(members.map((m) => m.id));
  const live = cam && (cam.keys.length > 0 || !!cam.motionBlur) ? cam : null;
  return overlays.map((o) => {
    if (!ids.has(o.id)) return o;
    if (!live) return withoutCamera(o);
    const camera: GroupCamera = {
      kf: [...live.keys]
        .sort((a, b) => a.t - b.t)
        .map((k) => ({ ...k, t: round3(k.t + start - o.start) })),
      ...(live.motionBlur ? { motionBlur: live.motionBlur } : {}),
    };
    return { ...o, camera } as Overlay;
  });
}

/** An element with no camera field at all. */
export function withoutCamera<O extends { camera?: GroupCamera }>(o: O): O {
  if (!("camera" in o)) return o;
  const { camera: _drop, ...rest } = o;
  void _drop;
  return rest as O;
}

/** The camera's pose at `tGroup` seconds into the group. */
export function groupCameraPoseAt(view: Pick<GroupCameraView, "keys">, tGroup: number): CameraPose {
  return cameraAt({ kf: view.keys }, tGroup);
}

/** The camera an element is filmed through at `tLocal` seconds into it, or
 * null when its group has none. */
export function elementCameraAt(o: { camera?: GroupCamera }, tLocal: number): CameraPose | null {
  return hasCameraKeys(o.camera) ? cameraAt(o.camera, tLocal) : null;
}
