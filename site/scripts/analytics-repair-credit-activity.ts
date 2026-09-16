// Run with --apply to repair the stored window after changing credit activity.
// Each write checks the object's ETag so a concurrent refresh stops the repair.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dayDbKey, extractCreditActivity, ROLLUP_KEY } from "../src/lib/analytics/pipeline";
import { analyticsDbDayFileSchema, analyticsRollupSchema } from "../src/lib/analytics/schema";
import { prisma } from "../src/lib/prisma";

const apply = process.argv.includes("--apply");
const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
if (!accountId || !accessKeyId || !secretAccessKey) throw new Error("R2 credentials are required.");
const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});
const Bucket = "donkey-cut";

async function read(Key: string) {
  const object = await client.send(new GetObjectCommand({ Bucket, Key }));
  if (!object.Body || !object.ETag) throw new Error(`Incomplete object: ${Key}`);
  const body = await object.Body.transformToString();
  return { key: Key, body, etag: object.ETag };
}

async function repair() {
  const original = await read(ROLLUP_KEY);
  const rollup = analyticsRollupSchema.parse(JSON.parse(original.body));
  const bitIndex = rollup.sources.indexOf("creditLedger");
  if (bitIndex < 0) throw new Error("Rollup has no credit activity source.");
  const bit = 1 << bitIndex;
  const writes: { original: Awaited<ReturnType<typeof read>>; body: string }[] = [];
  for (const [index, day] of rollup.days.entries()) {
    const stored = await read(dayDbKey(day));
    const db = analyticsDbDayFileSchema.parse(JSON.parse(stored.body));
    if (db.day !== day) throw new Error(`Day mismatch: ${day}`);
    const ids = await extractCreditActivity(day);
    const active = new Set(ids);
    const before = rollup.users.filter((user) => user.activity[index] !== 0).length;
    for (const user of rollup.users) {
      user.activity[index] = ((user.activity[index] ?? 0) & ~bit) | (active.has(user.id) ? bit : 0);
    }
    const after = rollup.users.filter((user) => user.activity[index] !== 0).length;
    db.active.creditLedger = ids;
    writes.push({ original: stored, body: JSON.stringify(db) });
    console.log(JSON.stringify({ day, before, after }));
  }
  writes.push({ original, body: JSON.stringify(rollup) });
  if (!apply) {
    console.log("Dry run complete. Use --apply to write the repaired window.");
    return;
  }
  const backup = await mkdtemp(join(tmpdir(), "donkey-analytics-backup-"));
  for (const [index, entry] of writes.entries()) {
    await writeFile(join(backup, `${index}.json`), entry.original.body, { mode: 0o600 });
  }
  console.log(`Original objects saved to ${backup}`);
  for (const entry of writes) {
    await client.send(new PutObjectCommand({
      Bucket,
      Key: entry.original.key,
      Body: entry.body,
      ContentType: "application/json",
      IfMatch: entry.original.etag,
    }));
  }
  const verified = await read(ROLLUP_KEY);
  if (verified.body !== writes[writes.length - 1].body) throw new Error("Rollup verification failed.");
  console.log(`Repaired and verified ${rollup.days.length} days.`);
}

try {
  await repair();
} finally {
  await prisma.$disconnect();
  client.destroy();
}
