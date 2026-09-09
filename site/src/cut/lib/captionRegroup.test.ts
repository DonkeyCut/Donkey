import { expect, test } from "bun:test";
import { useEditor } from "./store";
import { emptySubtitles } from "./types";

test("reapplying word grouping splits a script replaced after choosing the setting", async () => {
  const previous = useEditor.getState();
  useEditor.setState({
    subtitles: {
      ...emptySubtitles(),
      wordsPerCue: 2,
      cues: [{ id: "rewritten", start: 0, end: 4, text: "Keep every caption short and clear" }],
    },
    cutMixSamples: async () => { throw new Error("No audio in this project"); },
  });
  try {
    await useEditor.getState().setSubtitleWordsPerCue(2);
    const cues = useEditor.getState().subtitles.cues;
    expect(cues.map((cue) => cue.text)).toEqual(["Keep every", "caption short", "and clear"]);
    expect(cues[0].start).toBe(0);
    expect(cues[cues.length - 1].end).toBe(4);
  } finally {
    useEditor.setState(previous);
  }
});
