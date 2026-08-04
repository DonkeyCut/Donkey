/**
 * The assistant's scene-production tools — planning a narrated multi-shot
 * cut, the approval gate, and the shot-level revisions — kept beside the
 * scene plan card that exposes the storyboard in chat. The catalog spreads
 * this list into the model's toolset and `aiTools.ts` keys its handlers on
 * `SceneToolName`.
 */

import { num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const SCENE_TOOLS = [
  {
    name: "generate_scene",
    description:
      "Generate a narrated, multi-shot cut assembled on the timeline — script, voiceover, and several shots — from a brief, or animate audio already in the project. Use this only when the user names that kind of production (\"tell a story about…\", \"turn this into a narrated 20-second short\", \"an episode\"); a plain \"generate/make a video of/about X\" is a single clip — generate_video, not this. It writes a script, breaks it into shots, and draws each shot's opening frame, then RETURNS that storyboard and STOPS: the user reviews the frames (and can ask to redraw any of them with regenerate_shot — cheap, no credits at this stage) — get their go-ahead and call approve_scene before the shots render, because each shot spends credits. Pass from_audio_asset_id to animate an audio spine the project already has (a voiceover, recording, or song → shots tiled over it) instead of writing a new script. Read the scene-productions skill before your first call — it covers the brief and look, references, aspect, and the from-audio flow. Needs the user signed in to Donkey (spends credits).",
    inputSchema: obj({
      brief: str("What the video is about — the story or subject. Omit only when animating existing audio."),
      from_audio_asset_id: str("Animate this project audio asset (id from media) — shots tile over it instead of a new script"),
      audio_language: str("BCP-47 language of the from_audio asset's speech (e.g. ko-KR). REQUIRED with from_audio_asset_id whenever the speech is not English — the on-device transcriber picks its recognizer from it, and the wrong recognizer garbles every shot planned over the audio"),
      target_seconds: num("Rough total length in seconds, 6–90 (default ~24)"),
      style: str("Optional look to steer the whole video (e.g. 'moody neon, handheld'); usually left to the brief"),
      reference_asset_ids: {
        type: "array",
        items: { type: "string" },
        description: "Project image/video asset ids that anchor the look (the user's attached references)",
      },
    }),
  },
  {
    name: "approve_scene",
    description:
      "Approve the pending generate_scene shot plan and start rendering. The shots render in the background and land on the timeline as they finish. Call this only when the user confirms (\"go\", \"do it\", \"looks good\") — approving spends credits per shot.",
    inputSchema: obj({}),
  },
  {
    name: "cancel_scene",
    description:
      "Stop the scene generation running in this project — planning or rendering halts immediately and the plan is discarded. Clips already placed stay on the timeline; credits already spent are not refunded. Call it when the user wants the run stopped, or to clear the way for a new generate_scene.",
    inputSchema: obj({}),
  },
  {
    name: "regenerate_shot",
    description:
      "Redo one shot of the generated scene by its number (1-based), optionally nudging it (\"wider\", \"at night\", \"more energetic\"). At the storyboard gate (before approval) it redraws just that shot's opening frame — cheap, no credits, the run stays waiting for approval. After the scene has rendered it re-renders the shot and swaps its clip on the timeline by itself — never delete the clip first.",
    inputSchema: obj({ n: num("Shot number, 1-based"), note: str("Optional change to apply to that shot") }, ["n"]),
  },
  {
    name: "recut_scene",
    description:
      "Re-cut a contiguous span of the generated scene's shots: replans just that span against the same audio — it can split into more shots or merge into fewer — keeping the style, cast, and every other shot's clip, then renders only the new shots (credits per new shot). Use it when the user wants a section restructured (\"split the last shot\", \"shots 2-3 drag, tighten them\", \"that part is missing the soccer scene\"); one shot redone as-is is regenerate_shot, a whole-look change is restyle_scene. Only valid after a scene has finished.",
    inputSchema: obj({
      from_shot: num("First shot of the span, 1-based"),
      to_shot: num("Last shot of the span, 1-based (equal to from_shot for one shot)"),
      instruction: str("What the span should become — the content to cover and how to pace it"),
    }, ["from_shot", "to_shot", "instruction"]),
  },
  {
    name: "restyle_scene",
    description:
      "Restyle the whole generated scene and redo every shot with a new look (\"make it black-and-white film noir\", \"turn it into anime\"). Only valid after a scene has been generated. Spends credits (every shot re-renders), so confirm first.",
    inputSchema: obj({ style: str("The new look for the whole video") }, ["style"]),
  },
] as const satisfies readonly AiToolDef[];

export type SceneToolName = (typeof SCENE_TOOLS)[number]["name"];
