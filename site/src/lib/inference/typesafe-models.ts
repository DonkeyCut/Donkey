// The TypeSafe System One model behind every judgment call. The judge route
// pins it; the page and the worker never see it (eslint keeps the id out of
// their bundles). Bump here when adopting a newer Jev.
export const typesafeModels = {
  jev: "jev-latest",
} as const;

export type TypesafeModel = (typeof typesafeModels)[keyof typeof typesafeModels];

export const typesafeProviderId = "typesafe";
