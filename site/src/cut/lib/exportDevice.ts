// What the machine under an export offers, for the finish report: a slow
// render is read against the hardware it ran on.

import type { ExportSettings } from "./exportClient";

/** The device facts an export reports. */
export interface ExportDevice {
  cores: number;
  memoryGb: number;
  /** Whether WebCodecs offers a hardware encoder for the codec at this size. */
  hwEncoder: boolean;
  /** The graphics chip as WebGL names it ("ANGLE (Intel, Intel(R) UHD …"). */
  gpu: string;
}

/** Encoder probe strings: H.264 High 5.1 and HEVC Main 5.1 cover every size
 * the dialog offers. */
const PROBE_CODEC = { h264: "avc1.640033", hevc: "hvc1.1.6.L153.B0" } as const;

/** Long renderer strings carry driver build numbers; the head names the chip. */
const GPU_NAME_MAX = 80;

async function hasHwEncoder(settings: Pick<ExportSettings, "codec" | "width" | "height">): Promise<boolean> {
  if (typeof VideoEncoder === "undefined") {
    return false;
  }
  if (settings.codec !== "h264" && settings.codec !== "hevc") {
    return false;
  }

  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: PROBE_CODEC[settings.codec],
      width: settings.width,
      height: settings.height,
      hardwareAcceleration: "prefer-hardware",
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

function gpuName(): string {
  if (typeof OffscreenCanvas === "undefined") {
    return "";
  }

  try {
    const gl = new OffscreenCanvas(1, 1).getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const name = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return name.slice(0, GPU_NAME_MAX);
  } catch {
    return "";
  }
}

/** The machine's cores, memory, graphics chip, and whether it encodes these
 * settings in hardware. */
export async function exportDevice(
  settings: Pick<ExportSettings, "codec" | "width" | "height">
): Promise<ExportDevice> {
  return {
    cores: navigator.hardwareConcurrency || 0,
    memoryGb: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 0,
    hwEncoder: await hasHwEncoder(settings),
    gpu: gpuName(),
  };
}
