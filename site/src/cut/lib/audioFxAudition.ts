"use client";

/**
 * Hearing an audio effect before placing it.
 *
 * A picker tile for a picture effect shows what it does; a tile for a sound
 * treatment has to play it. This is the one player that does that: a line of
 * recorded speech, run through the same chain the mix would build, out of a
 * context of its own. The line is one of the voice personas already shipped
 * with the site, so the tiles play the same way in a project with no footage
 * in it yet — a picker is used before there is anything to use it on.
 *
 * The cross dissolve auditions as what it is: a man's line handing over to a
 * woman's across a cut — both speaking through the join, on the equal-power
 * ramps the render applies.
 *
 * A clip is fetched once and kept decoded for the session, so the first press
 * loads it and every press after plays it straight away. One audition at a
 * time, and starting one silences the shared preview player the other panels
 * use.
 */

import { audioFxRecipe, buildAudioFx, type AudioFxNodes } from "@donkeycut/effects-kit";
import { create } from "zustand";
import { scheduleCross } from "./audioMix";
import { registerPreviewSilencer, usePreviewAudio } from "./previewAudio";
import { voiceSampleUrl } from "./voices";

/** The id of the sound handover, auditioned as the handover itself. */
export const CROSS_DISSOLVE_AUDITION = "audiocross";

/**
 * The two lines the shelf plays.
 *
 * Both personas speak the same two sentences — the voice picker's sample text
 * — so the halves are used apart: a treatment runs on the second sentence, one
 * unbroken phrase with the end of the clip left on it for a delay to ring into,
 * and the handover plays the man's first sentence into the woman's second one,
 * which is two different lines meeting at a cut.
 */
const LINES = {
  /** Charlie, informative — an even read that filters and delays show on. */
  man: voiceSampleUrl("Charon"),
  /** Kate, firm — audibly another speaker, which is the point at a cut. */
  woman: voiceSampleUrl("Kore"),
};

/** Where the sentences sit in those clips, from the silence between them. */
const FIRST_SENTENCE = { at: 0.2, len: 1.55 };
const SECOND_SENTENCE = { at: 2.0, len: 2.5 };
/** Half the handover: the two lines overlap for twice this, with the cut in
 * the middle of it. */
const CROSS_WINDOW = 0.6;

interface AuditionState {
  /** The effect being played right now, or null. */
  effect: string | null;
  /** Play this effect's sample, or stop it when it is the one playing. */
  toggle: (effect: string, amount?: number) => void;
  stop: () => void;
}

let ctx: AudioContext | null = null;
let voices: AudioBufferSourceNode[] = [];
let chain: AudioFxNodes | null = null;
/** Guards a load that finished after its audition was cancelled. */
let token = 0;

const context = (): AudioContext => (ctx ??= new AudioContext());

/** The clips, fetched and decoded at most once each. A failed load drops out
 * of the cache so the next press tries again. */
const decoded = new Map<string, Promise<AudioBuffer>>();

function clip(target: AudioContext, url: string): Promise<AudioBuffer> {
  const hit = decoded.get(url);
  if (hit) return hit;
  const load = fetch(url)
    .then((r) => r.arrayBuffer())
    .then((bytes) => target.decodeAudioData(bytes));
  decoded.set(url, load);
  void load.catch(() => decoded.delete(url));
  return load;
}

function teardown(): void {
  for (const node of voices) {
    try {
      node.stop();
    } catch {
      // Already finished; stopping a spent node throws and means nothing.
    }
    node.disconnect();
  }
  voices = [];
  if (chain) {
    for (const node of chain.sources) {
      try {
        node.stop();
      } catch {
        // Already stopped.
      }
    }
    chain.input.disconnect();
    chain.output.disconnect();
    chain = null;
  }
}

export const useFxAudition = create<AuditionState>((set, get) => ({
  effect: null,
  toggle: (effect, amount) => {
    if (get().effect === effect) {
      get().stop();
      return;
    }
    teardown();
    // Two things playing at once teaches nothing about either.
    usePreviewAudio.getState().stop();
    const target = context();
    void target.resume();
    const mine = ++token;
    set({ effect });
    const done = () => {
      if (token === mine) {
        teardown();
        set({ effect: null });
      }
    };
    /** One side of an audition: a stretch of a clip, played at `when`. */
    const play = (
      buffer: AudioBuffer,
      part: { at: number; len: number },
      when: number,
      into: AudioNode,
      cross?: { from: number; rising: boolean }
    ) => {
      const node = target.createBufferSource();
      node.buffer = buffer;
      const gain = target.createGain();
      if (cross) {
        scheduleCross(gain.gain, 1, cross.from, cross.from + 2 * CROSS_WINDOW, cross.rising);
      }
      node.connect(gain);
      gain.connect(into);
      node.start(when, part.at, part.len);
      voices.push(node);
      return node;
    };

    if (effect === CROSS_DISSOLVE_AUDITION) {
      void Promise.all([clip(target, LINES.man), clip(target, LINES.woman)])
        .then(([man, woman]) => {
          if (token !== mine) return;
          const at = target.currentTime + 0.05;
          // What the render does: both lines are speaking across the join,
          // ramping past each other equal-power, with the picture's cut in
          // the middle of the window where they are equally loud.
          const from = at + FIRST_SENTENCE.len - 2 * CROSS_WINDOW;
          play(man, FIRST_SENTENCE, at, target.destination, { from, rising: false });
          const second = play(woman, SECOND_SENTENCE, from, target.destination, {
            from,
            rising: true,
          });
          second.onended = done;
        })
        .catch(done);
      return;
    }
    void clip(target, LINES.man)
      .then((buffer) => {
        if (token !== mine) return;
        const recipe = audioFxRecipe(effect, amount);
        let into: AudioNode = target.destination;
        if (recipe) {
          chain = buildAudioFx(target, recipe, target.currentTime);
          chain.output.connect(target.destination);
          into = chain.input;
        }
        const voice = play(buffer, SECOND_SENTENCE, target.currentTime + 0.05, into);
        voice.onended = done;
      })
      .catch(done);
  },
  stop: () => {
    token++;
    teardown();
    set({ effect: null });
  },
}));

// The other direction: a preview started anywhere else silences the audition.
registerPreviewSilencer(() => useFxAudition.getState().stop());
