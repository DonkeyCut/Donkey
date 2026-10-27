import { enrichAsset } from "@/cut/lib/media";
import { useEditor } from "@/cut/lib/store";
import { renderSpeechClip, speechClipToAsset, type SpeechLayout } from "@/cut/lib/tts";
import { UserError } from "@/cut/lib/userError";

/** Default duck: everything else drops to 40% while a voiceover speaks. */
export const DUCK_DEFAULT = 0.4;

interface ReadoutCue {
  id: string;
  text: string;
  start: number;
}

/** The cues to voice, in timeline order: the active subtitle track's cues
 * (reading every language at once would talk over itself), or just `cueIds`. */
function readoutCues(cueIds?: string[]): ReadoutCue[] {
  const wanted = cueIds && new Set(cueIds);
  const s = useEditor.getState();
  return s.subtitles.cues
    .filter((c) =>
      c.text.trim() && (wanted ? wanted.has(c.id) : (c.lane ?? 0) === s.subtitleLane)
    )
    .map((c) => ({ id: c.id, text: c.text, start: c.start }));
}

// The last rendered readout. Preview and Generate render through here, so a
// preview the user liked becomes the exact clip that lands on the timeline
// instead of a second (paid) synthesis. Keyed by everything that changes the
// audio, so any edit re-renders.
let cached: { sig: string; blob: Blob; offset: number; layout: SpeechLayout[]; language?: string } | null = null;

function signature(
  voice: string,
  cues: ReadoutCue[],
  opts?: { direction?: string; language?: string }
): string {
  return JSON.stringify([
    voice,
    opts?.language ?? "",
    opts?.direction ?? "",
    cues.map((c) => [c.text, c.start]),
  ]);
}

async function renderReadout(
  voice: string,
  cues: ReadoutCue[],
  opts?: { direction?: string; language?: string }
) {
  const sig = signature(voice, cues, opts);
  if (cached?.sig === sig) return cached;
  const { blob, offset, layout, language } = await renderSpeechClip(
    cues.map((c) => ({ text: c.text, at: c.start })),
    { voice, direction: opts?.direction, language: opts?.language }
  );
  cached = { sig, blob, offset, layout, language };
  return cached;
}

/**
 * Voice the subtitle cues (all of them, or just `opts.cueIds`) and drop the
 * result on the soundtrack at the first cue. The spoken pace differs from the
 * original recording, so the read cues are re-timed to the generated audio —
 * keeping the word highlighter in step. Shared by the panel button and the AI
 * assistant's read_subtitles_aloud tool. Throws with a user-facing message on
 * failure.
 */
export async function generateSubtitlesReadout(
  voice: string,
  opts?: { cueIds?: string[]; direction?: string; language?: string; duck?: number }
) {
  const projectId = useEditor.getState().projectId;
  if (!projectId) {
    throw new UserError("project_open_required", "Open a project first.");
  }
  const cues = readoutCues(opts?.cueIds);
  if (cues.length === 0) {
    throw new UserError("subtitles_none_to_read", "No subtitles to read.");
  }

  const { blob, offset, layout, language } = await renderReadout(voice, cues, opts);
  const asset = await speechClipToAsset(projectId, blob, "Subtitles readout", language);
  const duck = opts?.duck ?? DUCK_DEFAULT;
  const cur = useEditor.getState();
  cur.addAsset(asset);
  cur.addAudioFromAsset(asset.id, offset, { duck: duck < 1 ? duck : undefined });
  if (layout.length === cues.length) {
    cur.retimeCues(
      layout.map((seg, i) => ({
        id: cues[i].id,
        start: seg.at,
        // Stop at the next line's start so re-timed captions never overlap.
        end: Math.min(seg.at + seg.duration, layout[i + 1]?.at ?? Infinity),
      }))
    );
  }
  void enrichAsset(asset);
  return { asset, start: offset, lines: cues.length, duck: duck < 1 ? duck : null };
}
