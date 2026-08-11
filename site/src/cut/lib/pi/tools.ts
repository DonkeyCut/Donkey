import type { TSchema } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AiToolDef } from "../aiToolDef";
import type { DonkeyToolDetails, WirePart } from "./donkeyStream";

// The tool bridge: the shared AiToolDef catalog as pi AgentTools. Execution is
// injected — production serves skills locally and runs everything else on the
// live editor store; the eval serves sims and stubs — so this file carries no
// environment of its own.

export type ExecTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

const DATA_URL = /^data:([^;,]+);base64,(.+)$/;

/** A tool's raw output split for the wire: media (frames, audio) moves to its
 * own following user turn — Gemini degenerates when media shares a turn with a
 * functionResponse — and megabyte payloads stay out of the JSON the model and
 * the UI transcript carry. */
export function toToolResult(name: string, output: unknown): AgentToolResult<DonkeyToolDetails> {
  if (output && typeof output === "object" && "audio" in output) {
    const { audio, ...rest } = output as { audio?: unknown; name?: unknown };
    const m = typeof audio === "string" ? DATA_URL.exec(audio) : null;
    if (m) {
      const assetName = typeof rest.name === "string" ? rest.name : name;
      return {
        content: [{ type: "text", text: JSON.stringify(rest) }],
        details: {
          response: rest,
          mediaParts: [
            { text: `Attached audio "${assetName}":` },
            { type: "input_audio", dataBase64: m[2], mimeType: m[1] },
          ],
        },
      };
    }
  }
  if (output && typeof output === "object" && ("image" in output || "images" in output)) {
    const { image, images, ...rest } = output as {
      image?: unknown;
      images?: unknown;
      source?: { name?: unknown };
    };
    const parsed = [
      ...(typeof image === "string" ? [image] : []),
      ...(Array.isArray(images) ? images.filter((u): u is string => typeof u === "string") : []),
    ]
      .map((u) => DATA_URL.exec(u))
      .filter((m): m is RegExpExecArray => m !== null);
    if (parsed.length > 0) {
      const sourceName = typeof rest.source?.name === "string" ? rest.source.name : null;
      const mediaParts: WirePart[] = [
        { text: sourceName ? `Frames from ${name} of "${sourceName}":` : `Frames from ${name}:` },
        ...parsed.map((m) => ({ type: "input_image", dataBase64: m[2], mimeType: m[1] })),
      ];
      return {
        content: [{ type: "text", text: JSON.stringify(rest) }],
        details: { response: rest, mediaParts },
      };
    }
  }
  const response =
    output && typeof output === "object" && !Array.isArray(output)
      ? output
      : { result: output ?? null };
  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    details: { response },
  };
}

export function toAgentTools(defs: AiToolDef[], execTool: ExecTool): AgentTool[] {
  return defs.map((def) => ({
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: def.inputSchema as unknown as TSchema,
    execute: async (_toolCallId, params) =>
      toToolResult(def.name, await execTool(def.name, params as Record<string, unknown>)),
  }));
}
