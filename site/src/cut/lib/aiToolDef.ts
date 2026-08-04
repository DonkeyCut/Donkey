/**
 * The shape of one assistant tool and the JSON Schema helpers for writing
 * them. Panel-owned tools live beside their panel components (the
 * `*.tools.ts` siblings under `components/`); the catalog imports those
 * lists, so this module stays dependency-free enough for the engine binary,
 * the browser, and the panels to share.
 */

export interface AiToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Handled directly by the server (no browser round-trip). */
  server?: boolean;
}

export const obj = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const num = (description: string) => ({ type: "number", description });
export const str = (description: string) => ({ type: "string", description });
export const bool = (description: string) => ({ type: "boolean", description });
