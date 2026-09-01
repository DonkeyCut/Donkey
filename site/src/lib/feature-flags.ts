// The registry of account flags. A flag ships here first; the account settings
// page renders this list and the API accepts only these ids. `group` decides
// which settings section a flag sits in: an editor preference everyone has, or
// an early feature an account opts into.

export type AccountFeatureFlag = {
  id: string;
  title: string;
  description: string;
  group: "editor" | "early";
  /** The state an account with no row of its own gets. A flag that has shipped
   * to everyone defaults on and the switch becomes an opt-out. */
  defaultEnabled: boolean;
};

export const CREDITS_PILL_FLAG = "editor_credits_pill";

export const ACCOUNT_FEATURE_FLAGS: AccountFeatureFlag[] = [
  {
    id: CREDITS_PILL_FLAG,
    title: "Show credits in the editor",
    description: "Your remaining balance in the editor's top bar.",
    group: "editor",
    defaultEnabled: true,
  },
];

export const isKnownFeatureFlag = (id: string) =>
  ACCOUNT_FEATURE_FLAGS.some((f) => f.id === id);
