/**
 * Binding a separately recorded sound to a video: find where the recording
 * lines up with the camera's own track, and only when one alignment clearly
 * wins, write it onto the video asset (`soundFrom`). The Audio tab's Sound
 * picker and the assistant's sync_audio both land here, so the person and the
 * assistant hold the recording to the same bar.
 */

import { syncSourceSound } from "./media";
import { cutSound } from "./soundSettings";
import { useEditor } from "./store";
import { assetIsSilent, type MediaAsset } from "./types";
import { queueWatchSweep } from "./watch/sweep";

interface BoundSound {
  assetId: string;
  audioAssetId: string;
  /** Recording seconds = video seconds + offset. */
  offset: number;
  /** The best alignment over the runner-up a second or more away. */
  confidence: number;
  /** Whether the offset sits on the sample (else on 20 ms). */
  refined: boolean;
  /** Clips of the video on the timeline, all now sounding from the recording. */
  clips: number;
}

/**
 * Line `audioId` up with `videoId` and bind it. `near` is the source span of
 * the clip the person is working on, so the camera's stretch that is matched
 * is the one they care about. Throws a readable Error when the files cannot
 * be matched or no alignment stands out; nothing is bound then.
 */
export async function bindRecording(
  videoId: string,
  audioId: string,
  near?: { in: number; out: number }
): Promise<BoundSound> {
  const s = useEditor.getState();
  const video = s.assets.find((a) => a.id === videoId);
  const rec = s.assets.find((a) => a.id === audioId);
  if (!video || video.type !== "video") throw new Error("That video is no longer in the project.");
  if (!rec) throw new Error("That recording is no longer in the project.");
  if (rec.type !== "audio") throw new Error(`"${rec.name}" is not an audio file.`);
  if (assetIsSilent(video))
    throw new Error(`"${video.name}" has no sound of its own to line the recording up against.`);
  if (!(video.duration > 0) || !(rec.duration > 0)) throw new Error("Both files must finish importing first.");
  const { syncProbeSeconds, syncMaxSeconds, syncMinConfidence } = cutSound();
  const [cameraFrom, cameraTo] = probeWindow(video, syncProbeSeconds, near);
  const answer = await syncSourceSound(video.url, rec.url, {
    cameraFrom,
    cameraTo,
    recordingTo: Math.min(rec.duration, syncMaxSeconds),
  });
  if (!answer || answer.confidence < syncMinConfidence) {
    const read = answer ? ` (confidence ${answer.confidence.toFixed(2)}, needs ${syncMinConfidence})` : "";
    throw new Error(
      `No clear alignment between "${rec.name}" and "${video.name}"${read}. They may be different takes, or share too little sound.`
    );
  }
  const offset = Math.round(answer.offset * 1e5) / 1e5;
  useEditor.getState().setAssetSoundFrom(video.id, { assetId: rec.id, offset });
  // Its transcript is heard again, off the recording.
  queueWatchSweep(video.id);
  return {
    assetId: video.id,
    audioAssetId: rec.id,
    offset,
    confidence: Math.round(answer.confidence * 100) / 100,
    refined: answer.refined,
    clips: useEditor.getState().clips.filter((c) => c.assetId === video.id).length,
  };
}

/** Return a video to its own sound. */
export function unbindRecording(videoId: string): void {
  useEditor.getState().setAssetSoundFrom(videoId, undefined);
  queueWatchSweep(videoId);
}

/** The camera's stretch to match: `seconds` long, centred on the clip being
 * worked on, else on the middle of the video, inside the file. */
function probeWindow(video: MediaAsset, seconds: number, near?: { in: number; out: number }): [number, number] {
  const len = Math.min(seconds, video.duration);
  const mid = near ? (near.in + near.out) / 2 : video.duration / 2;
  const from = Math.max(0, Math.min(video.duration - len, mid - len / 2));
  return [from, from + len];
}
