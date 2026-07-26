import type { CardColor } from "@/app/_components/landing/theme";

import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export const GITHUB_REPO_URL = "https://github.com/DonkeyUseCorp/Donkey";
// The install page lives on donkeycut.com only, so landing CTAs link absolute.
export const DONKEY_INSTALL_URL = `${DONKEYCUT_CANONICAL}/install`;
export const DONKEY_LATEST_VERSION = "0.1.89";
export const DONKEY_LATEST_RELEASE_TAG = `v${DONKEY_LATEST_VERSION}`;
export const DONKEY_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/${DONKEY_LATEST_RELEASE_TAG}/Donkey.dmg`;

export const solutionCards = [
  {
    color: "blue",
    tag: "01 - Knowledge workers",
    title: "Drafts, research and inbox triage on tap.",
    body: "PMs, founders and operators get back the hour-long detours: comp research, drafting, summarising threads, scheduling.",
  },
  {
    color: "yellow",
    tag: "02 - Engineers",
    title: "Donkey handles the un-fun half of the job.",
    body: "Triage bug reports, scaffold migrations, run flaky tests, prepare PR descriptions. Stays on your machine, on your branch.",
  },
  {
    color: "mint",
    tag: "03 - Designers",
    title: "Source references, version, ship.",
    body: "Mine Pinterest and Dribbble for boards. Rename, label and version your Figma library while you focus on the next sketch.",
  },
  {
    color: "pink",
    tag: "04 - Solo operators",
    title: "A full back office without the headcount.",
    body: "Expense logging, invoice chasing, calendar tetris across time zones, lead enrichment. Donkey runs the chores.",
  },
] satisfies Array<{
  body: string;
  color: CardColor;
  tag: string;
  title: string;
}>;

export const comparisonRows = [
  { label: "Runs locally on your Mac", gpts: false, donkey: true, humans: true },
  { label: "Handles 20+ apps end-to-end", gpts: false, donkey: true, humans: true },
  {
    label: "Streams progress in the notch",
    gpts: false,
    donkey: true,
    humans: false,
  },
  { label: "Pauses for your review", gpts: false, donkey: true, humans: true },
  { label: "Works offline and on-device", gpts: false, donkey: true, humans: true },
  { label: "24/7 availability", gpts: true, donkey: true, humans: false },
  { label: "Predictable monthly cost", gpts: true, donkey: true, humans: false },
  { label: "Onboarding under 5 minutes", gpts: true, donkey: true, humans: false },
];

export const openSourceReasons = [
  {
    color: "blue",
    icon: "View",
    title: "Audit every line.",
    body: "Donkey runs on your machine and touches your files. You should know exactly what it does. Every commit is public.",
  },
  {
    color: "yellow",
    icon: "Models",
    title: "Bring your own keys.",
    body: "Donkey wraps one provider today, but you hold the keys: plug in your own, or fork the code to add another. Want a provider supported out of the box? Open an issue.",
  },
  {
    color: "mint",
    icon: "Data",
    title: "Know where your data goes.",
    body: "Donkey is open source, so you can see exactly what leaves your Mac and where it goes. No hidden telemetry, no surprise uploads.",
  },
  {
    color: "pink",
    icon: "Own",
    title: "No vendor lock-in.",
    body: "Self-host the whole thing. Donkey runs without our cloud, our auth, or our blessing. You stay in control.",
  },
] satisfies Array<{
  body: string;
  color: CardColor;
  icon: string;
  title: string;
}>;
