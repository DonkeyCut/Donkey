// The registry of account feature flags. A flag ships here first; the account
// settings page renders this list and the API accepts only these ids.

export type AccountFeatureFlag = {
  id: string;
  title: string;
  description: string;
  /** The state an account with no row of its own gets. A flag that has shipped
   * to everyone defaults on and the switch becomes an opt-out. */
  defaultEnabled: boolean;
};

export const ACCOUNT_FEATURE_FLAGS: AccountFeatureFlag[] = [
  {
    id: "preview_diagnostics",
    title: "Share preview diagnostics",
    description:
      "Sends timing from the preview while you play: frames that arrived late, how far the picture sat behind the sound, and what your machine was holding open. It is how we fix stutters on machines we cannot reproduce. Your video, audio and project stay in your browser.",
    defaultEnabled: false,
  },
];

export const isKnownFeatureFlag = (id: string) =>
  ACCOUNT_FEATURE_FLAGS.some((f) => f.id === id);
