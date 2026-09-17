import { z } from "zod";

export const WIDGET_URI = "ui://donkey/project-preview-v1.html";
// ChatGPT's sandbox drops every null-valued key from a tool result before the
// widget sees it, so an absent value parses whether it arrives as null or as a
// missing key.
export const projectSchema = z.object({ id: z.string(), name: z.string(), url: z.url(), revision: z.string() });
export const jobStatusSchema = z.enum(["queued", "running", "done", "error", "expired"]);
export const previewSchema = z.object({ id: z.string(), status: jobStatusSchema, progress: z.number(), revision: z.string().nullish(), error: z.string().optional() });
/** A finished export downloads from the widget; the model gets the project link. */
export const exportSchema = z.object({ id: z.string(), status: jobStatusSchema, progress: z.number(), name: z.string().nullish(), error: z.string().optional() });
/** Any queued work the caller may poll with get_job_status. */
export const jobSchema = z.object({ id: z.string(), kind: z.string(), status: jobStatusSchema, progress: z.number(), error: z.string().optional() });
/** One command's outcome inside a batch. */
export const outcomeSchema = z.object({ name: z.string(), ok: z.boolean(), output: z.unknown().optional(), error: z.string().optional() });
export const accountSchema = z.object({ credits: z.string(), storageBytes: z.number(), storageQuotaBytes: z.number().nullish(), plan: z.string() });
export const viewSchema = z.object({
  view: z.enum(["projects", "project"]), projects: z.array(projectSchema), nextCursor: z.string().nullish(),
  project: projectSchema.nullish(), preview: previewSchema.nullish(), canRender: z.boolean(), canEdit: z.boolean(),
  export: exportSchema.nullish(), job: jobSchema.nullish(), results: z.array(outcomeSchema), changed: z.boolean(),
  account: accountSchema.nullish(),
});
export const playbackSchema = z.object({ url: z.url(), expiresAt: z.number() });
export const downloadSchema = z.object({ url: z.url(), expiresAt: z.number(), name: z.string() });
/** A one-use link the card frames to sign the editor in; spent once loaded. */
export const editorSchema = z.object({ url: z.url(), expiresAt: z.number() });
export type ProjectView = z.infer<typeof viewSchema>;
export type Playback = z.infer<typeof playbackSchema>;
export type Download = z.infer<typeof downloadSchema>;
export type Editor = z.infer<typeof editorSchema>;
