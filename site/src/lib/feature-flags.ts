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

export const ACCOUNT_FEATURE_FLAGS: AccountFeatureFlag[] = [];

export const isKnownFeatureFlag = (id: string) =>
  ACCOUNT_FEATURE_FLAGS.some((f) => f.id === id);
