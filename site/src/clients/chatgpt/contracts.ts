import { z } from "zod";

export const WIDGET_URI = "ui://donkey/project-preview-v1.html";
export const projectSchema = z.object({ id: z.string(), name: z.string(), url: z.url(), revision: z.string() });
export const previewSchema = z.object({ id: z.string(), status: z.enum(["queued", "running", "done", "error", "expired"]), progress: z.number(), revision: z.string().nullable(), error: z.string().optional() });
export const viewSchema = z.object({
  view: z.enum(["projects", "project"]), projects: z.array(projectSchema), nextCursor: z.string().nullable(),
  project: projectSchema.nullable(), preview: previewSchema.nullable(), canRender: z.boolean(),
});
export const playbackSchema = z.object({ url: z.url(), expiresAt: z.number() });
export type ProjectView = z.infer<typeof viewSchema>;
export type Playback = z.infer<typeof playbackSchema>;
