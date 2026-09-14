// The registry of account flags. A flag ships here first; the account settings
// page renders this list and the API accepts only these ids. `group` decides
// which settings section a flag sits in: an editor preference everyone has, an
// early feature an account opts into, or a super-user switch only that role
// sees and can set.

export type AccountFeatureFlagGroup = "editor" | "early" | "su";

export type AccountFeatureFlag = {
  id: string;
  title: string;
  description: string;
  group: AccountFeatureFlagGroup;
  /** The state an account with no row of its own gets. A flag that has shipped
   * to everyone defaults on and the switch becomes an opt-out. */
  defaultEnabled: boolean;
};

export const CREDITS_PILL_FLAG = "editor_credits_pill";
export const HIDE_PROMOTIONS_FLAG = "su_hide_promotions";

export const ACCOUNT_FEATURE_FLAGS: AccountFeatureFlag[] = [
  {
    id: CREDITS_PILL_FLAG,
    title: "Show credits in the editor",
    description: "Your remaining balance in the editor's top bar.",
    group: "editor",
    defaultEnabled: true,
  },
  {
    id: HIDE_PROMOTIONS_FLAG,
    title: "Hide promotions",
    description: "No credit offers or subscribe bonuses for this account: the top bar pill, the offer dialog and the Pro card's offer.",
    group: "su",
    defaultEnabled: false,
  },
];

/** The flags an account can see and set: the super-user group is only there
 * for that role. */
export const featureFlagsFor = (superUser: boolean) =>
  ACCOUNT_FEATURE_FLAGS.filter((f) => superUser || f.group !== "su");

export const isKnownFeatureFlag = (id: string) =>
  ACCOUNT_FEATURE_FLAGS.some((f) => f.id === id);
