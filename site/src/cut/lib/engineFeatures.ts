/**
 * What this engine build can carry beyond the shape every build shares. The
 * engine lists these in its health answer; the page reads them before it
 * hands an engine work an older app would silently drop. A build from before
 * the list existed answers with none.
 */
export const ENGINE_FEATURES = ["export.range", "export.name"] as const;

export type EngineFeature = (typeof ENGINE_FEATURES)[number];
