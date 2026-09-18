import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  addPhoneClip,
  claimPhoneClip,
  claimPhonePairing,
  listPhoneClips,
  listPhoneDevices,
  movePhoneClipToProject,
  openPhonePairing,
  phoneClipPath,
  phoneDeviceForToken,
  phonePairingClose,
  phonePairingWindow,
  releasePhoneClip,
  removePhoneClip,
  removePhoneDevice,
  sweepPhoneInbox,
  type PhoneDeviceInfo,
} from "./phoneLink";

let dataDir: string;
let staging: string;
let previous: string | undefined;

beforeEach(async () => {
  previous = process.env.DONKEY_CUT_DATA_DIR;
  dataDir = await mkdtemp(path.join(tmpdir(), "phone-link-"));
  staging = await mkdtemp(path.join(tmpdir(), "phone-staged-"));
  process.env.DONKEY_CUT_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.DONKEY_CUT_DATA_DIR;
  else process.env.DONKEY_CUT_DATA_DIR = previous;
  await rm(dataDir, { force: true, recursive: true });
  await rm(staging, { force: true, recursive: true });
});

/** A clip the app has staged in the temp directory, ready to be moved in. */
async function staged(name: string, contents: string): Promise<string> {
  const file = path.join(staging, `${crypto.randomUUID()}-${name}`);
  await writeFile(file, contents);
  return file;
}

async function pairedPhone(): Promise<PhoneDeviceInfo> {
  const open = openPhonePairing();
  return (await claimPhonePairing(open.code, "iPhone"))!.device;
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const inbox = () => path.join(dataDir, "phone", "inbox");

test("a phone pairs on the open code, and only on that code", async () => {
  const open = openPhonePairing();
  expect(await claimPhonePairing("000-000", "Wrong phone")).toBeNull();

  const paired = await claimPhonePairing(open.code, "David's iPhone");
  expect(paired?.device.name).toBe("David's iPhone");
  expect(paired?.token).toHaveLength(64);

  // The code is spent: a second phone cannot ride the same one in.
  expect(await claimPhonePairing(open.code, "Someone else's iPhone")).toBeNull();
  expect(phonePairingClose()).toBe("paired");
});

test("three wrong answers close the window", async () => {
  const open = openPhonePairing();
  for (let i = 0; i < 3; i++) {
    expect(await claimPhonePairing("111-111", "Guesser")).toBeNull();
  }
  expect(phonePairingWindow()).toBeNull();
  expect(phonePairingClose()).toBe("refused");
  // Even the right code is no good once the window is shut.
  expect(await claimPhonePairing(open.code, "iPhone")).toBeNull();
  expect(await listPhoneDevices()).toHaveLength(0);
});

test("the token never lands on disk", async () => {
  const open = openPhonePairing();
  const paired = await claimPhonePairing(open.code, "iPhone");
  const devices = await readFile(path.join(dataDir, "phone", "devices.json"), "utf8");
  expect(devices).not.toContain(paired!.token);
  expect(await listPhoneDevices()).toHaveLength(1);
});

test("a token is only good while its device is paired", async () => {
  const open = openPhonePairing();
  const paired = (await claimPhonePairing(open.code, "iPhone"))!;
  expect((await phoneDeviceForToken(paired.token))?.id).toBe(paired.device.id);

  await removePhoneDevice(paired.device.id);
  expect(await phoneDeviceForToken(paired.token)).toBeNull();
});

test("an upload in flight cannot undo an unpair", async () => {
  const open = openPhonePairing();
  const paired = (await claimPhonePairing(open.code, "iPhone"))!;

  // The upload's last-seen touch and the unpair race: both read the list, both
  // write it back. Serialized, the removal is the one that stands.
  const touching = phoneDeviceForToken(paired.token);
  const unpairing = removePhoneDevice(paired.device.id);
  await Promise.all([touching, unpairing]);

  expect(await listPhoneDevices()).toHaveLength(0);
  expect(await phoneDeviceForToken(paired.token)).toBeNull();
});

test("clips land in the inbox oldest shot first and leave on claim", async () => {
  const device = await pairedPhone();

  const second = await addPhoneClip(device, await staged("b.mov", "second take"), {
    takeId: "take-b",
    fileName: "b.mov",
    capturedAt: 2000,
  });
  await addPhoneClip(device, await staged("a.mov", "first take"), {
    takeId: "take-a",
    fileName: "a.mov",
    capturedAt: 1000,
  });

  const clips = await listPhoneClips();
  expect(clips.map((c) => c.fileName)).toEqual(["a.mov", "b.mov"]);
  expect(clips[1].bytes).toBe("second take".length);

  expect(await readFile((await phoneClipPath(second.id))!, "utf8")).toBe("second take");

  await removePhoneClip(second.id);
  expect(await phoneClipPath(second.id)).toBeNull();
  expect(await listPhoneClips()).toHaveLength(1);
});

test("the same take arriving twice is one clip", async () => {
  const device = await pairedPhone();
  const input = { takeId: "take-1", fileName: "a.mov", capturedAt: 1000 };

  const first = await addPhoneClip(device, await staged("a.mov", "the take"), input);
  // The phone never read the acknowledgement, so it sends the same take again.
  const resend = await staged("a.mov", "the take");
  const second = await addPhoneClip(device, resend, input);

  expect(second.id).toBe(first.id);
  expect(await listPhoneClips()).toHaveLength(1);
  // The re-sent file is not left lying in staging.
  expect(await exists(resend)).toBe(false);
});

test("only one editor can claim a clip", async () => {
  const device = await pairedPhone();
  const clip = await addPhoneClip(device, await staged("a.mov", "the take"), {
    takeId: "take-1",
    fileName: "a.mov",
  });

  const [a, b] = await Promise.all([claimPhoneClip(clip.id), claimPhoneClip(clip.id)]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  // A claimed clip is not offered again.
  expect(await listPhoneClips()).toHaveLength(0);
  // Its bytes are still readable by whoever holds it.
  expect(await phoneClipPath(clip.id)).not.toBeNull();
});

test("a released clip goes back in the inbox", async () => {
  const device = await pairedPhone();
  const clip = await addPhoneClip(device, await staged("a.mov", "the take"), {
    takeId: "take-1",
    fileName: "a.mov",
  });

  expect(await claimPhoneClip(clip.id)).not.toBeNull();
  await releasePhoneClip(clip.id);
  expect((await listPhoneClips()).map((c) => c.id)).toEqual([clip.id]);
  // And it can be claimed again.
  expect(await claimPhoneClip(clip.id)).not.toBeNull();
});

test("a clip moves into a project without a copy", async () => {
  const device = await pairedPhone();
  const clip = await addPhoneClip(device, await staged("a.mov", "the take"), {
    takeId: "take-1",
    fileName: "a.mov",
  });
  await claimPhoneClip(clip.id);

  const projectId = crypto.randomUUID();
  await mkdir(path.join(dataDir, "projects", projectId), { recursive: true });

  const fileName = await movePhoneClipToProject(clip.id, projectId);
  const landed = path.join(dataDir, "projects", projectId, "media", fileName);
  expect(await readFile(landed, "utf8")).toBe("the take");
  // Nothing of it is left in the inbox.
  expect(await phoneClipPath(clip.id)).toBeNull();
  expect(await listPhoneClips()).toHaveLength(0);
});

test("the sweep clears orphans, records with no bytes, and stale clips", async () => {
  const device = await pairedPhone();
  const keep = await addPhoneClip(device, await staged("keep.mov", "keeping"), {
    takeId: "take-keep",
    fileName: "keep.mov",
  });

  // Bytes from a transfer that broke before its record was written.
  const orphan = path.join(inbox(), `${crypto.randomUUID()}.mov`);
  await writeFile(orphan, "half a take");

  // A record whose bytes are gone.
  const gone = await addPhoneClip(device, await staged("gone.mov", "going"), {
    takeId: "take-gone",
    fileName: "gone.mov",
  });
  await rm((await phoneClipPath(gone.id))!, { force: true });

  // A clip older than the inbox keeps.
  const stale = await addPhoneClip(device, await staged("old.mov", "ancient"), {
    takeId: "take-old",
    fileName: "old.mov",
  });
  const staleMeta = path.join(inbox(), `${stale.id}.json`);
  await writeFile(
    staleMeta,
    JSON.stringify({ ...stale, receivedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 })
  );

  await sweepPhoneInbox();

  expect(await exists(orphan)).toBe(false);
  expect(await phoneClipPath(gone.id)).toBeNull();
  expect(await phoneClipPath(stale.id)).toBeNull();
  expect((await listPhoneClips()).map((c) => c.id)).toEqual([keep.id]);
});

test("a record with no bytes is never offered", async () => {
  const device = await pairedPhone();
  const clip = await addPhoneClip(device, await staged("a.mov", "the take"), {
    takeId: "take-1",
    fileName: "a.mov",
  });
  await rm((await phoneClipPath(clip.id))!, { force: true });
  expect(await listPhoneClips()).toHaveLength(0);
});

test("a phone cannot name a path", async () => {
  const device = await pairedPhone();

  const clip = await addPhoneClip(device, await staged("passwd.mov", "x"), {
    takeId: "take-1",
    fileName: "../../../../etc/passwd.mov",
  });
  expect(clip.fileName).toBe("passwd.mov");
  // The bytes are written under an id of ours, inside the inbox.
  expect(await phoneClipPath(clip.id)).toBe(path.join(inbox(), `${clip.id}.mov`));
});

test("a staged clip comes only from the staging directory", async () => {
  const device = await pairedPhone();
  await expect(
    addPhoneClip(device, "/etc/passwd", { takeId: "take-1", fileName: "take.mov" })
  ).rejects.toThrow("temp directory");
});
