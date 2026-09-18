import { SETTINGS, type Settings } from "@/lib/config/registry";

let runtime: Settings["chatRuntime"] = SETTINGS.chatRuntime.default;
export function bindChatRuntime(value: unknown): void {
  const parsed = SETTINGS.chatRuntime.schema.safeParse(value);
  if (parsed.success) runtime = parsed.data;
}
export function chatRuntime(): Settings["chatRuntime"] { return runtime; }

let judge: Settings["cutJudge"] = SETTINGS.cutJudge.default;
export function bindCutJudge(value: unknown): void {
  const parsed = SETTINGS.cutJudge.schema.safeParse(value);
  if (parsed.success) judge = parsed.data;
}
export function cutJudge(): Settings["cutJudge"] { return judge; }

let clip: Settings["cutClip"] = SETTINGS.cutClip.default;
export function bindCutClip(value: unknown): void {
  const parsed = SETTINGS.cutClip.schema.safeParse(value);
  if (parsed.success) clip = parsed.data;
}
export function cutClip(): Settings["cutClip"] { return clip; }
