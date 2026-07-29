"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square, Video, X } from "lucide-react";
import {
  BufferTarget,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
} from "mediabunny";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatTimecode } from "@/cut/lib/time";
import { cn } from "@/lib/utils";

export type RecordMode = "camera" | "audio";

// A take is muxed here rather than handed to MediaRecorder, so what comes out
// is an MP4 whichever browser recorded it — with a real duration in its header,
// which a WebM from MediaRecorder does not have. Codecs are picked by asking
// what this browser can actually encode, in preference order, instead of
// guessing at MIME strings and hoping the recording isn't empty.
const VIDEO_CODECS = ["avc", "vp9", "av1", "vp8"] as const;
const AUDIO_CODECS = ["aac", "opus"] as const;

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

type DeviceOption = { id: string; label: string };

// Remembers the last device pick per kind so reopening the dialog restores it.
// Chrome keeps deviceIds stable per-origin once permission is granted.
const STORE_KEY = { videoinput: "cut.record.cameraId", audioinput: "cut.record.micId" };
function loadDeviceId(kind: "videoinput" | "audioinput"): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORE_KEY[kind]);
  } catch {
    return null;
  }
}
function saveDeviceId(kind: "videoinput" | "audioinput", id: string | null) {
  try {
    if (id) window.localStorage.setItem(STORE_KEY[kind], id);
    else window.localStorage.removeItem(STORE_KEY[kind]);
  } catch {
    // Ignore storage failures (private mode, quota); the pick just won't persist.
  }
}

function toOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind, fallback: string) {
  return devices
    .filter((d) => d.kind === kind && d.deviceId)
    .sort((a, b) => Number(b.deviceId === "default") - Number(a.deviceId === "default"))
    .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
}

export function RecordDialog({
  mode,
  onClose,
  onUse,
}: {
  mode: RecordMode;
  onClose: () => void;
  onUse: (file: File) => void;
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  // Restore the last pick; null = browser default. The pills show the device
  // the live stream landed on.
  const [cameraId, setCameraId] = useState<string | null>(() => loadDeviceId("videoinput"));
  const [micId, setMicId] = useState<string | null>(() => loadDeviceId("audioinput"));
  const videoRef = useRef<HTMLVideoElement>(null);
  const outputRef = useRef<Output<Mp4OutputFormat, BufferTarget> | null>(null);
  // Setting up the encoders is a round trip, so the button can be hit again
  // before `recording` flips. This claims the take at the click.
  const startingRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let canceled = false;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    const audio: MediaTrackConstraints | boolean = micId
      ? { deviceId: { exact: micId } }
      : true;
    const constraints: MediaStreamConstraints =
      mode === "camera"
        ? {
            video: {
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              ...(cameraId ? { deviceId: { exact: cameraId } } : {}),
            },
            audio,
          }
        : { audio };
    navigator.mediaDevices
      .getUserMedia(constraints)
      .then(async (s) => {
        if (canceled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = s;
        setStream(s);
        // Device labels are only populated once permission is granted.
        const list = await navigator.mediaDevices.enumerateDevices();
        if (!canceled) setDevices(list);
      })
      .catch(() => {
        if (canceled) return;
        if (cameraId || micId) {
          // The picked device failed to start; fall back to the default and
          // forget it so we don't keep restoring a dead device.
          setCameraId(null);
          setMicId(null);
          saveDeviceId("videoinput", null);
          saveDeviceId("audioinput", null);
          setNotice("That device could not be started — switched back to the default.");
          return;
        }
        setError(
          mode === "camera"
            ? "Camera access was blocked. Allow camera and microphone for this site in Chrome, then try again."
            : "Microphone access was blocked. Allow the microphone for this site in Chrome, then try again."
        );
      });
    return () => {
      canceled = true;
      // A take abandoned mid-record is thrown away rather than finalized —
      // nothing is waiting for the file.
      if (outputRef.current?.state === "started") void outputRef.current.cancel();
      outputRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [mode, cameraId, micId]);

  useEffect(() => {
    const refresh = () =>
      navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {});
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, []);

  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => {});
    }
  }, [stream]);

  useEffect(() => {
    if (!recording) return;
    const start = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - start) / 1000), 100);
    return () => clearInterval(t);
  }, [recording]);

  const startRecording = async () => {
    if (!stream || outputRef.current || startingRef.current) return;
    startingRef.current = true;
    const videoTrack = mode === "camera" ? stream.getVideoTracks()[0] : undefined;
    const audioTrack = stream.getAudioTracks()[0];
    try {
      const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
      if (videoTrack) {
        const codec = await getFirstEncodableVideoCodec([...VIDEO_CODECS]);
        if (!codec) throw new Error("This browser can't encode video.");
        output.addVideoTrack(
          new MediaStreamVideoTrackSource(videoTrack, { codec, bitrate: QUALITY_HIGH })
        );
      }
      if (audioTrack) {
        const codec = await getFirstEncodableAudioCodec([...AUDIO_CODECS]);
        if (!codec) throw new Error("This browser can't encode audio.");
        output.addAudioTrack(
          new MediaStreamAudioTrackSource(audioTrack, { codec, bitrate: QUALITY_MEDIUM })
        );
      }
      await output.start();
      outputRef.current = output;
      setElapsed(0);
      setRecording(true);
    } catch {
      setError(
        mode === "camera"
          ? "This browser could not start a camera recording. Check that no other app is using the camera, then try again."
          : "This browser could not start a recording. Try again."
      );
    } finally {
      startingRef.current = false;
    }
  };

  const stopRecording = async () => {
    const output = outputRef.current;
    if (!output) return;
    outputRef.current = null;
    setRecording(false);
    try {
      await output.finalize();
    } catch {
      setError("The recording could not be saved. Try again.");
      return;
    }
    const buffer = output.target.buffer;
    if (!buffer || buffer.byteLength === 0) {
      setError(
        "The recording came back empty. Check that no other app is using the camera, then try again."
      );
      return;
    }
    // An MP4 holding only sound takes the audio extension and MIME, so it
    // reads as audio wherever a name or a type is all there is to go on.
    const audioOnly = mode !== "camera";
    const label = audioOnly ? "Voice" : "Camera";
    const file = new File([buffer], `${label} recording ${stamp()}${audioOnly ? ".m4a" : ".mp4"}`, {
      type: audioOnly ? "audio/mp4" : "video/mp4",
    });
    onUse(file);
    onClose();
  };

  // Picking a device clears the fallback notice so the live guidance returns —
  // the notice is set once on a device failure and must not outlive the retry.
  const pickCamera = (id: string) => {
    setNotice(null);
    setCameraId(id);
    saveDeviceId("videoinput", id);
  };
  const pickMic = (id: string) => {
    setNotice(null);
    setMicId(id);
    saveDeviceId("audioinput", id);
  };

  const cameras = toOptions(devices, "videoinput", "Camera");
  const mics = toOptions(devices, "audioinput", "Microphone");
  const activeCameraId =
    cameraId ?? stream?.getVideoTracks()[0]?.getSettings().deviceId ?? "";
  const activeMicId =
    micId ?? stream?.getAudioTracks()[0]?.getSettings().deviceId ?? "";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "gap-0 overflow-hidden p-0 transition-[max-width] duration-200",
          // Compact while waiting for permission; grow to a full preview once
          // the camera is live. Audio mode keeps a steady width.
          mode === "audio"
            ? "sm:max-w-md"
            : stream
              ? "sm:max-w-lg"
              : "sm:max-w-xs"
        )}
      >
        {/* Kept for accessibility; the dialog reads as its own preview. */}
        <DialogTitle className="sr-only">
          {mode === "camera" ? "Record camera" : "Record audio"}
        </DialogTitle>
        {/* Custom close so it stays legible over the full-bleed video. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className="absolute top-2 right-2 z-20 grid size-8 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65"
        >
          <X className="size-4" />
        </button>

        {error ? (
          <p className="p-6 text-sm text-muted-foreground">{error}</p>
        ) : (
          <>
            {mode === "camera" ? (
              <div className="relative w-full min-w-0 overflow-hidden bg-black">
                {/* Mirrored preview; the recording itself is not mirrored. */}
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className="aspect-video w-full -scale-x-100 object-cover"
                />
                {stream && (
                  <LiveWaveform
                    stream={stream}
                    className={cn(
                      "absolute inset-x-0 bottom-3 h-8 w-full text-white/80",
                      recording && "text-red-400"
                    )}
                  />
                )}
                {recording && <RecTimer elapsed={elapsed} />}
              </div>
            ) : (
              <div className="px-6 pt-10">
                <div className="relative grid h-36 place-items-center rounded-xl bg-muted px-4 pb-12">
                  {stream ? (
                    <LiveWaveform
                      stream={stream}
                      className={cn("h-16 w-full text-foreground/70", recording && "text-red-500")}
                    />
                  ) : (
                    <span className="grid size-16 place-items-center rounded-full bg-card text-foreground shadow-sm">
                      <Mic className="size-7" />
                    </span>
                  )}
                  {recording && <RecTimer elapsed={elapsed} />}
                  <div className="absolute inset-x-0 bottom-2 flex justify-center px-2">
                    <DevicePill
                      icon={<Mic className="size-3.5 shrink-0" />}
                      options={mics}
                      value={activeMicId}
                      onChange={pickMic}
                      disabled={recording}
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="min-w-0 space-y-2 px-6 pt-3 pb-6">
              {mode === "camera" && (
                <div className="flex justify-center gap-2">
                  <DevicePill
                    icon={<Video className="size-3.5 shrink-0" />}
                    options={cameras}
                    value={activeCameraId}
                    onChange={pickCamera}
                    disabled={recording}
                  />
                  <DevicePill
                    icon={<Mic className="size-3.5 shrink-0" />}
                    options={mics}
                    value={activeMicId}
                    onChange={pickMic}
                    disabled={recording}
                  />
                </div>
              )}
              <div className="flex justify-center">
                {!recording ? (
                  <button
                    className="grid size-12 place-items-center rounded-full border-[3px] border-foreground/20 transition-transform hover:scale-105 disabled:opacity-40"
                    title="Start recording"
                    disabled={!stream}
                    onClick={() => void startRecording()}
                  >
                    <span className="size-8 rounded-full bg-red-500" />
                  </button>
                ) : (
                  <button
                    className="grid size-12 place-items-center rounded-full border-[3px] border-red-500/40 transition-transform hover:scale-105"
                    title="Stop and use recording"
                    onClick={() => void stopRecording()}
                  >
                    <Square className="size-5 fill-red-500 stroke-none" />
                  </button>
                )}
              </div>
              {!recording && (notice || !stream) && (
                <p className="text-center text-xs text-muted-foreground">
                  {notice ?? "Waiting for permission…"}
                </p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Meet-style rounded device picker: icon + truncated device name + chevron. */
function DevicePill({
  icon,
  options,
  value,
  onChange,
  disabled,
}: {
  icon: React.ReactNode;
  options: DeviceOption[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  if (options.length === 0) return null;
  const items = Object.fromEntries(options.map((o) => [o.id, o.label]));
  return (
    <Select
      value={items[value] ? value : options[0].id}
      items={items}
      onValueChange={(id) => onChange(id as string)}
    >
      <SelectTrigger
        size="sm"
        disabled={disabled}
        className="max-w-[46%] min-w-0 rounded-full border-white/25 bg-black/55 text-xs text-white backdrop-blur-sm hover:bg-black/70 dark:bg-black/55 dark:hover:bg-black/70 [&_svg]:text-white/80"
      >
        {icon}
        <SelectValue className="truncate" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="w-auto max-w-72">
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// RMS below this reads as silence and draws no bar.
const SILENCE = 0.015;

/** Scrolling level meter fed by the stream's audio track; color follows CSS `color`.
 * `sampleMs` sets how much time each bar spans — larger values scroll slower and
 * cover a longer window (the loudest moment in the window wins). Omitted, it
 * advances one bar per animation frame (the record dialog's original feel). */
export function LiveWaveform({
  stream,
  className,
  sampleMs,
}: {
  stream: MediaStream;
  className?: string;
  sampleMs?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Bar color follows CSS `color`. Resolve it only when the className changes
  // (i.e. when `recording` toggles) instead of every animation frame.
  const colorRef = useRef("");
  useEffect(() => {
    if (canvasRef.current) colorRef.current = getComputedStyle(canvasRef.current).color;
  }, [className]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || stream.getAudioTracks().length === 0) return;
    const audioCtx = new AudioContext();
    void audioCtx.resume().catch(() => {});
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const levels: number[] = [];
    let raf = 0;
    let lastPush = 0;
    let peak = 0;

    const draw = (ts: number) => {
      raf = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / samples.length);

      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(canvas.clientWidth * dpr);
      const height = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const barWidth = 3 * dpr;
      const step = barWidth + 2 * dpr;
      const maxBars = Math.max(1, Math.floor(width / step));

      const g = canvas.getContext("2d");
      if (!g) return;
      g.clearRect(0, 0, width, height);
      g.fillStyle = colorRef.current || getComputedStyle(canvas).color;
      // Idle input draws a row of small centered dots so the meter reads as a
      // ready track spanning the whole width; sound grows each into a bar.
      const idle = barWidth;
      const bar = (x: number, level: number) => {
        if (x + barWidth < 0 || x > width) return;
        const h = level >= SILENCE ? Math.max(idle, Math.min(1, level * 3) * height) : idle;
        const r = Math.min(barWidth / 2, h / 2);
        g.beginPath();
        g.roundRect(x, (height - h) / 2, barWidth, h, r);
        g.fill();
      };

      if (!sampleMs) {
        // Record dialog: one bar per frame, right-aligned (its original feel).
        levels.push(rms);
        while (levels.length < maxBars) levels.unshift(0);
        if (levels.length > maxBars) levels.splice(0, levels.length - maxBars);
        for (let i = 0; i < levels.length; i++) bar(width - (levels.length - i) * step, levels[i]);
        return;
      }

      // Commit one bar per `sampleMs` (that's the time scale) but slide the whole
      // strip left every frame by the fraction of the window elapsed, so motion
      // is continuous instead of ticking a full bar at once. Committed bars hold
      // the window's peak; a forming bar at the right edge tracks the live level.
      if (lastPush === 0) lastPush = ts;
      peak = Math.max(peak, rms);
      if (ts - lastPush >= sampleMs) {
        levels.push(peak);
        peak = 0;
        lastPush = ts;
      }
      while (levels.length < maxBars + 1) levels.unshift(0);
      if (levels.length > maxBars + 2) levels.splice(0, levels.length - (maxBars + 2));
      const offset = Math.min(1, (ts - lastPush) / sampleMs) * step;
      const n = levels.length;
      for (let i = 0; i < n; i++) bar(width - step - (n - i) * step - offset, levels[i]);
      bar(width - step - offset, rms);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      void audioCtx.close().catch(() => {});
    };
  }, [stream, sampleMs]);

  return <canvas ref={canvasRef} className={className} />;
}

function RecTimer({ elapsed }: { elapsed: number }) {
  return (
    <span className="absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 font-mono text-xs text-white tabular-nums">
      <span className="size-2 animate-pulse rounded-full bg-red-500" />
      {formatTimecode(elapsed)}
    </span>
  );
}
