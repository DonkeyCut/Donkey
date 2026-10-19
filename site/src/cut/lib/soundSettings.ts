// The sound editing constants, read where a clip's sound is laid out.
export const CUT_SOUND = {
  // The ramp at the outer end of a split edit's sound, so the sound that
  // leads or trails the picture never starts or stops on a click.
  splitFadeSeconds: 0.03,
  // How much clearer the best alignment of a separate recording has to be
  // than the runner-up before it is bound.
  syncMinConfidence: 1.4,
  // How much of the camera's own sound the alignment listens to.
  syncProbeSeconds: 90,
  // The longest recording searched end to end.
  syncMaxSeconds: 2 * 3600,
};
