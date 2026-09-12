// A finished edit as a stored document, carrying one of everything a
// template can hold: framing, rate, grade, mask, keys, a box-styled layer,
// transition bars at every edge, a look as an effect element, a grouped
// keyed title, a title in an uploaded font, a sticker, a music bed with
// fades, captions in a look, and the project's frame. Tests describe it,
// template it, and replicate it.

import { transitionBarStart, type ProjectDoc } from "../types";

export const RICH_CLIP_S = 10;

export function richDoc(): ProjectDoc {
  const now = 1_700_000_000_000;
  const c0Len = RICH_CLIP_S / 1.25;
  return {
    version: 1,
    id: "rich",
    name: "Rich edit",
    createdAt: now,
    updatedAt: now,
    aspect: "16:9",
    background: "#102030",
    fadeIn: 0.3,
    fadeOut: 0.4,
    assets: [
      {
        id: "v0",
        fileName: "clip-0.mp4",
        name: "host.mp4",
        type: "video",
        duration: RICH_CLIP_S,
        width: 1280,
        height: 720,
        watch: {
          ranges: [{ from: 0, to: RICH_CLIP_S }],
          frames: [{ t: 0, via: "global" }],
          sceneChanges: [],
          notes: [{ from: 0, to: RICH_CLIP_S, text: "a host talks to camera" }],
        },
        speech: {
          ranges: [{ from: 0, to: RICH_CLIP_S }],
          segments: [{ start: 0, end: 4, text: "hello and welcome" }],
        },
      },
      { id: "v1", fileName: "clip-1.mp4", name: "broll.mp4", type: "video", duration: RICH_CLIP_S, width: 1280, height: 720 },
      { id: "m0", fileName: "music.m4a", name: "bed.m4a", type: "audio", duration: 8, origin: "generated", beats: { beats: [0.5, 1, 1.5], bpm: 120 } },
      { id: "s0", fileName: "arrow.png", name: "arrow.png", type: "image", duration: 0, width: 200, height: 200, origin: "sticker" },
      { id: "f0", fileName: "brand.ttf", name: "Brand", type: "font", duration: 0 },
    ],
    clips: [
      {
        id: "c0", assetId: "v0", track: 0, start: 0, in: 0, out: RICH_CLIP_S,
        muted: false, volume: 0.8,
        fit: "fill", zoom: 1.4, panX: 0.3, panY: -0.2,
        speed: 1.25,
      },
      {
        id: "c1", assetId: "v1", track: 0, start: c0Len, in: 0, out: RICH_CLIP_S,
        muted: false,
        fit: "fit",
        grade: { brightness: 5, contrast: 8, saturation: -10, temperature: 12, hue: 10 },
        mask: { kind: "circle", w: 0.7, h: 0.7, feather: 20 },
        kf: [
          { t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
          { t: 2, x: 0.6, y: 0.4, scale: 0.85, rotation: 12, opacity: 1 },
        ],
      },
      {
        id: "c2", assetId: "v0", track: 1, start: 1, in: 0, out: 1.5,
        muted: true,
        frame: { x: 0.55, y: 0.05, w: 0.4, h: 0.4 },
        fit: "fill", rotation: 5, opacity: 0.9,
        boxStyle: { radius: 24, borderWidth: 4, borderColor: "#ffffff" },
        hidden: false,
      },
    ],
    transitions: [
      { id: "tr-in", start: 0, seconds: 0.4, style: "crossfade" },
      { id: "tr0", start: transitionBarStart("crossfade", "cut", c0Len, 0.5), seconds: 0.5, style: "crossfade" },
      { id: "tr-out", start: transitionBarStart("crosszoom", "out", c0Len + RICH_CLIP_S, 0.5), seconds: 0.5, style: "crosszoom" },
    ],
    audioClips: [
      { id: "a0", assetId: "m0", start: 0, in: 0, out: 5, volume: 0.5, fadeIn: 0.3, fadeOut: 0.5, lane: 0, duck: 0.4 },
    ],
    overlays: [
      {
        id: "e0", kind: "effect", effect: "vintage", amount: 0.6,
        start: 0, end: c0Len, x: 0.5, y: 0.5, lane: 2, hostClipId: "c0",
      },
      {
        id: "t0", kind: "text", text: "Everything test",
        start: 0.5, end: 3, x: 0.5, y: 0.2, lane: 0,
        size: 64, font: "sf", weight: 700, color: "#FFFFFF",
        shadow: true, plate: true, groupId: "g1",
        kf: [
          { t: 0, x: 0.5, y: 0.2, scale: 1, rotation: 0, opacity: 0 },
          { t: 0.5, x: 0.5, y: 0.2, scale: 1, rotation: 0, opacity: 1 },
        ],
      },
      {
        id: "t1", kind: "text", text: "Brand line",
        start: 3, end: 5, x: 0.5, y: 0.8, lane: 0,
        size: 48, font: "asset:f0", weight: 400, color: "#FFDD00",
        shadow: false, plate: false, groupId: "g1",
      },
      {
        id: "s1", kind: "sticker", assetId: "s0", w: 0.2,
        start: 2, end: 4, x: 0.8, y: 0.3, lane: 1,
      },
    ],
    subtitles: {
      cues: [
        { id: "q0", start: 0.3, end: 1.2, text: "every feature" },
        { id: "q1", start: 1.4, end: 2.2, text: "in one render" },
      ],
      showOnVideo: true,
      showOnTimeline: false,
      style: "bubble",
      size: 60,
      wordsPerCue: 3,
      wordHighlight: true,
      accentColor: "#FF3366",
      x: 0.5,
      y: 0.85,
    },
  };
}
