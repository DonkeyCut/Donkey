// The starter project every new account is seeded with (server/cloud/starter.ts).
// Its id is derived from the owner, so the seed is idempotent and the client
// can address the project straight from the session without a lookup.
export const starterProjectId = (userId: string) => `starter-${userId}`;

/** Whether an id addresses an account's starter project. */
export const isStarterProjectId = (id: string) => id.startsWith("starter-");
