import { prisma } from "../src/lib/prisma";

// Installs and usage of the ChatGPT app, read from ChatgptEvent.
//   NODE_ENV=production npx bun --env-file=.env scripts/chatgpt-usage.ts [days]
// days is the window the report covers (default 30).

const DEFAULT_DAYS = 30;
const DAY_MS = 86_400_000;
const days = Number(process.argv[2] ?? DEFAULT_DAYS);
if (!Number.isFinite(days) || days <= 0) {
  throw new Error("Pass the window as a positive number of days.");
}

const since = new Date(Date.now() - days * DAY_MS);
const inWindow = { createdAt: { gte: since } };

const [connects, connectedUsers, liveGrants, callers, byTool] = await Promise.all([
  prisma.chatgptEvent.count({ where: { kind: "connect", ...inWindow } }),
  prisma.chatgptEvent.findMany({ where: { kind: "connect", ...inWindow }, distinct: ["userId"], select: { userId: true } }),
  prisma.chatgptGrant.findMany({ where: { revokedAt: null, expiresAt: { gt: new Date() } }, distinct: ["userId"], select: { userId: true } }),
  prisma.chatgptEvent.findMany({ where: { kind: "tool", ...inWindow }, distinct: ["userId"], select: { userId: true } }),
  prisma.chatgptEvent.groupBy({ by: ["tool", "ok"], where: { kind: "tool", ...inWindow }, _count: { _all: true } }),
]);

// Fold the ok/failed pairs into one line per tool, busiest first.
const tools = new Map<string, { calls: number; failed: number }>();
for (const row of byTool) {
  const entry = tools.get(row.tool ?? "") ?? { calls: 0, failed: 0 };
  entry.calls += row._count._all;
  entry.failed += row.ok ? 0 : row._count._all;
  tools.set(row.tool ?? "", entry);
}
const ranked = [...tools].sort((a, b) => b[1].calls - a[1].calls);
const total = ranked.reduce((sum, [, entry]) => sum + entry.calls, 0);

console.log(`ChatGPT app, last ${days} days`);
console.log(`Connections approved: ${connects} (${connectedUsers.length} accounts)`);
console.log(`Accounts connected now: ${liveGrants.length}`);
console.log(`Accounts that called a tool: ${callers.length}`);
console.log(`Tool calls: ${total}`);
for (const [tool, entry] of ranked) {
  console.log(`  ${tool}: ${entry.calls}${entry.failed ? ` (${entry.failed} failed)` : ""}`);
}

await prisma.$disconnect();
