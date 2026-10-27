import type auth from "@/i18n/messages/en/auth.json";
import type billing from "@/i18n/messages/en/billing.json";
import type chat from "@/i18n/messages/en/chat.json";
import type chatgpt from "@/i18n/messages/en/chatgpt.json";
import type common from "@/i18n/messages/en/common.json";
import type editor from "@/i18n/messages/en/editor.json";
import type errors from "@/i18n/messages/en/errors.json";
import type home from "@/i18n/messages/en/home.json";
import type inspector from "@/i18n/messages/en/inspector.json";
import type install from "@/i18n/messages/en/install.json";
import type labels from "@/i18n/messages/en/labels.json";
import type landing from "@/i18n/messages/en/landing.json";
import type legal from "@/i18n/messages/en/legal.json";
import type media from "@/i18n/messages/en/media.json";
import type mock from "@/i18n/messages/en/mock.json";
import type onboarding from "@/i18n/messages/en/onboarding.json";
import type panels from "@/i18n/messages/en/panels.json";
import type settings from "@/i18n/messages/en/settings.json";
import type share from "@/i18n/messages/en/share.json";
import type timeline from "@/i18n/messages/en/timeline.json";

// Every catalog is split into namespaces, one JSON file per namespace per
// locale (messages/<locale>/<namespace>.json). The English files are the
// source and the type: a key missing from English is a compile error at the
// call site, and messages.test.ts holds every other locale to the same keys.
export type Messages = {
  auth: typeof auth;
  billing: typeof billing;
  chat: typeof chat;
  chatgpt: typeof chatgpt;
  common: typeof common;
  editor: typeof editor;
  errors: typeof errors;
  home: typeof home;
  inspector: typeof inspector;
  install: typeof install;
  labels: typeof labels;
  landing: typeof landing;
  legal: typeof legal;
  media: typeof media;
  mock: typeof mock;
  onboarding: typeof onboarding;
  panels: typeof panels;
  settings: typeof settings;
  share: typeof share;
  timeline: typeof timeline;
};

export type Namespace = keyof Messages;

export const NAMESPACES = [
  "auth",
  "billing",
  "chat",
  "chatgpt",
  "common",
  "editor",
  "errors",
  "home",
  "inspector",
  "install",
  "labels",
  "landing",
  "legal",
  "media",
  "mock",
  "onboarding",
  "panels",
  "settings",
  "share",
  "timeline",
] as const satisfies readonly Namespace[];

// What each subtree hands its client components. A page ships only the
// namespaces it renders, so the landing never carries the editor's catalog.
export const PUBLIC_NAMESPACES = [
  "common",
  "auth",
  "billing",
  "install",
  "landing",
  "legal",
  "mock",
] as const satisfies readonly Namespace[];

// The editor, wherever it is drawn: the app and a shared project's viewer.
export const EDITOR_NAMESPACES = [
  "common",
  "billing",
  "chat",
  "editor",
  "errors",
  "home",
  "inspector",
  "labels",
  "media",
  "mock",
  "onboarding",
  "panels",
  "timeline",
] as const satisfies readonly Namespace[];

export const APP_NAMESPACES = [...EDITOR_NAMESPACES, "settings"] as const satisfies readonly Namespace[];

export const SHARE_NAMESPACES = [...EDITOR_NAMESPACES, "share"] as const satisfies readonly Namespace[];
