// The parts of a template the server carries whole, shared by the engine's
// on-disk library and its cloud twin. Kept free of filesystem imports so the
// hosted bundle never traces the engine.
export interface TemplateExtras {
  /** Opaque, round-tripped for the client: transition bars, which texts are
   * stickers drawn from media, the caption look, the source's frame. */
  transitions?: unknown[];
  stickers?: unknown[];
  captions?: unknown;
  project?: unknown;
}

export const templateExtras = (input: TemplateExtras): TemplateExtras => ({
  ...(input.transitions?.length ? { transitions: input.transitions } : {}),
  ...(input.stickers?.length ? { stickers: input.stickers } : {}),
  ...(input.captions ? { captions: input.captions } : {}),
  ...(input.project ? { project: input.project } : {}),
});
