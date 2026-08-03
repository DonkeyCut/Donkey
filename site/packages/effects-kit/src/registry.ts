/**
 * Element plugin registry: one registration per element kind. The built-in
 * kinds (text, shape, sticker) paint without registering; a host registers a
 * plugin to add a custom kind or replace a built-in painter.
 */

import type { PaintFrame, RenderEnv } from "./render";
import type { Overlay } from "./types";

export interface ElementPlugin<T extends Overlay = Overlay> {
  kind: string;
  paint(
    ctx: CanvasRenderingContext2D,
    element: T,
    frame: PaintFrame,
    env: RenderEnv
  ): void | Promise<void>;
}

const plugins = new Map<string, ElementPlugin>();

export function defineElement<T extends Overlay>(plugin: ElementPlugin<T>): void {
  plugins.set(plugin.kind, plugin as unknown as ElementPlugin);
}

export function elementPlugin(kind: string): ElementPlugin | undefined {
  return plugins.get(kind);
}
