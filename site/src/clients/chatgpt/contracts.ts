import { z } from "zod";

export const WIDGET_URI = "ui://donkey/project-preview-v1.html";
export const projectSchema = z.object({ id: z.string(), name: z.string(), url: z.url(), revision: z.string() });
export const jobStatusSchema = z.enum(["queued", "running", "done", "error", "expired"]);
export const previewSchema = z.object({ id: z.string(), status: jobStatusSchema, progress: z.number(), revision: z.string().nullable(), error: z.string().optional() });
/** A finished export downloads from the widget; the model gets the project link. */
export const exportSchema = z.object({ id: z.string(), status: jobStatusSchema, progress: z.number(), name: z.string().nullable(), error: z.string().optional() });
/** Any queued work the caller may poll with get_job_status. */
export const jobSchema = z.object({ id: z.string(), kind: z.string(), status: jobStatusSchema, progress: z.number(), error: z.string().optional() });
/** One command's outcome inside a batch. */
export const outcomeSchema = z.object({ name: z.string(), ok: z.boolean(), output: z.unknown().optional(), error: z.string().optional() });
/** What undo and redo would each revert, by the step's label. */
export const historySchema = z.object({ undo: z.string().nullable(), redo: z.string().nullable() });
export const accountSchema = z.object({ credits: z.string(), storageBytes: z.number(), storageQuotaBytes: z.number().nullable(), plan: z.string() });
export const viewSchema = z.object({
  view: z.enum(["projects", "project"]), projects: z.array(projectSchema), nextCursor: z.string().nullable(),
  project: projectSchema.nullable(), preview: previewSchema.nullable(), canRender: z.boolean(), canEdit: z.boolean(),
  export: exportSchema.nullable(), job: jobSchema.nullable(), results: z.array(outcomeSchema), changed: z.boolean(),
  history: historySchema.nullable(), account: accountSchema.nullable(),
});
export const playbackSchema = z.object({ url: z.url(), expiresAt: z.number() });
export const downloadSchema = z.object({ url: z.url(), expiresAt: z.number(), name: z.string() });
export type ProjectView = z.infer<typeof viewSchema>;
export type Playback = z.infer<typeof playbackSchema>;
export type Download = z.infer<typeof downloadSchema>;
