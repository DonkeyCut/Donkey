import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cutDataRoot } from "./dataDir";
import { assertLocalRuntime } from "./local-only";
import { mediaDir, mediaPath } from "./projects";
import { exists, uniqueName, writeJsonAtomic } from "./util";

/**
 * The phone link: clips shot on an iPhone in the field, handed to this Mac over
 * peer-to-peer Wi-Fi and held here until the editor takes them.
 *
 * The engine owns both halves of it. Pairing is a code the settings page mints
 * and the phone answers with, which buys the phone a token it keeps; every clip
 * after that arrives carrying the token. The app's listener is a pipe — it
 * terminates the peer connection and forwards here, so the only place a device
 * or a pending clip is written down is this Mac's disk.
 *
 * The inbox is a staging area, not storage: a clip sits in it until an open
 * editor claims it into a project, wherever that project lives. That indirection
 * is what lets a browser-resident project receive from a phone at all — the page
 * pulls the bytes off loopback and writes them into its own OPFS.
 *
 * Two editors can be open on one Mac, so taking a clip is a claim rather than a
 * read: the claim renames the record, which the filesystem performs for exactly
 * one caller, and the loser finds nothing to rename. A claim that is never
 * finished — the tab closed mid-import — lapses back into the inbox.
 */

const phoneRoot = () => path.join(cutDataRoot(), "phone");
const devicesPath = () => path.join(phoneRoot(), "devices.json");
const inboxRoot = () => path.join(phoneRoot(), "inbox");
const clipMetaPath = (id: string) => path.join(inboxRoot(), `${id}.json`);
/** A claimed clip's record, under a name a second claim cannot find. */
const claimedMetaPath = (id: string) => path.join(inboxRoot(), `${id}.claimed.json`);

/** A phone that has paired with this Mac. The token never lands on disk — only
 * its hash, so a readable devices.json is not a credential. */
export interface PhoneDevice {
  id: string;
  name: string;
  tokenHash: string;
  pairedAt: number;
  lastSeenAt: number;
}

/** A device as anything outside this module sees it. */
export type PhoneDeviceInfo = Omit<PhoneDevice, "tokenHash">;

/** A clip waiting in the inbox for an editor to claim it. */
export interface PhoneClip {
  id: string;
  /** The take's id on the phone, stable across re-sends. A phone that loses an
   * acknowledgement sends the take again; this is how the second arrival is
   * recognised as the copy already here. */
  takeId: string;
  deviceId: string;
  deviceName: string;
  /** The name the file takes when it lands in a project. */
  fileName: string;
  bytes: number;
  /** When the phone shot it, by the phone's clock. */
  capturedAt: number;
  receivedAt: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** When an editor claimed it. Only on a claimed record. */
  claimedAt?: number;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Constant-time compare of two hex digests of equal length. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// MARK: Devices

/**
 * Every change to the device list runs through here, one at a time.
 *
 * The list is read, changed and written back with awaits in between, so two of
 * those interleaved would each write a list built before the other's change: an
 * upload touching its device's last-seen stamp would put back a device the user
 * had just unpaired, and the revoked token would keep working.
 */
let deviceWrites: Promise<unknown> = Promise.resolve();

function withDeviceList<T>(work: (devices: PhoneDevice[]) => Promise<T> | T): Promise<T> {
  const next = deviceWrites.then(async () => work(await readDevices()));
  // The chain carries on after a failure; one bad write does not wedge the rest.
  deviceWrites = next.catch(() => {});
  return next;
}

async function readDevices(): Promise<PhoneDevice[]> {
  try {
    const raw = await readFile(devicesPath(), "utf8");
    const parsed = JSON.parse(raw) as { devices?: PhoneDevice[] };
    return Array.isArray(parsed.devices) ? parsed.devices : [];
  } catch {
    return [];
  }
}

async function writeDevices(devices: PhoneDevice[]): Promise<void> {
  await mkdir(phoneRoot(), { recursive: true });
  await writeJsonAtomic(devicesPath(), { devices });
}

/** A device with its token hash left behind — what leaves this module. */
function publicDevice(device: PhoneDevice): PhoneDeviceInfo {
  return {
    id: device.id,
    name: device.name,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
  };
}

export function listPhoneDevices(): Promise<PhoneDeviceInfo[]> {
  assertLocalRuntime();
  return withDeviceList((devices) =>
    devices.sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(publicDevice)
  );
}

export function removePhoneDevice(id: string): Promise<void> {
  assertLocalRuntime();
  return withDeviceList(async (devices) => {
    await writeDevices(devices.filter((d) => d.id !== id));
  });
}

/** The device a token belongs to, with its last-seen stamp moved up. Null for a
 * token no paired device holds. */
export function phoneDeviceForToken(token: string): Promise<PhoneDeviceInfo | null> {
  assertLocalRuntime();
  if (!token) return Promise.resolve(null);
  const hash = hashToken(token);
  return withDeviceList(async (devices) => {
    const device = devices.find((d) => sameHash(d.tokenHash, hash));
    if (!device) return null;
    device.lastSeenAt = Date.now();
    await writeDevices(devices);
    return publicDevice(device);
  });
}

// MARK: Pairing

/** How long a pairing code is good for. Long enough to walk to the phone and
 * type it, short enough that a code left on screen is not a standing key. */
const PAIRING_TTL_MS = 5 * 60 * 1000;

/** Wrong answers a window survives. Six digits is 810,000 codes, which is a lot
 * to read off a screen and nothing at all to a machine in radio range working
 * through them, so the window closes long before guessing pays. */
const PAIRING_ATTEMPTS = 3;

/** The open pairing window, in memory only: the engine dies with the app, and a
 * code that outlived a restart would be a code nobody is watching. */
let pending: { code: string; expiresAt: number; attemptsLeft: number } | null = null;
/** Why the last window ended, for the card to explain itself. */
let lastClose: PhonePairingClose = null;

/** How a window ended: a phone took it, or someone guessed at it. */
export type PhonePairingClose = "paired" | "refused" | null;

/** Six digits in two groups — read aloud across a room, typed on a phone. */
const mintCode = () => `${randomInt(100, 1000)}-${randomInt(100, 1000)}`;

export interface PhonePairingWindow {
  code: string;
  expiresAt: number;
}

/** Open a pairing window, replacing any code still standing. */
export function openPhonePairing(): PhonePairingWindow {
  assertLocalRuntime();
  lastClose = null;
  pending = {
    code: mintCode(),
    expiresAt: Date.now() + PAIRING_TTL_MS,
    attemptsLeft: PAIRING_ATTEMPTS,
  };
  return { code: pending.code, expiresAt: pending.expiresAt };
}

/** The window still open, or null once it has lapsed. */
export function phonePairingWindow(): PhonePairingWindow | null {
  if (pending && pending.expiresAt <= Date.now()) pending = null;
  return pending ? { code: pending.code, expiresAt: pending.expiresAt } : null;
}

/** Why the window that is no longer open ended, for the card to say so. */
export function phonePairingClose(): PhonePairingClose {
  return phonePairingWindow() ? null : lastClose;
}

export function closePhonePairing(): void {
  pending = null;
  lastClose = null;
}

/** Answer a pairing code with a device name, and the phone is paired: it gets
 * back the token every later upload carries. A code is spent on first use, and
 * a few wrong answers close the window rather than leaving it standing to be
 * guessed at. Null when no window is open or the code is wrong. */
export function claimPhonePairing(
  code: string,
  deviceName: string
): Promise<{ device: PhoneDeviceInfo; token: string } | null> {
  assertLocalRuntime();
  const open = pending;
  if (!open || open.expiresAt <= Date.now()) {
    pending = null;
    return Promise.resolve(null);
  }
  if (code.trim() !== open.code) {
    open.attemptsLeft -= 1;
    if (open.attemptsLeft <= 0) {
      pending = null;
      lastClose = "refused";
    }
    return Promise.resolve(null);
  }
  pending = null;
  lastClose = "paired";

  const token = randomBytes(32).toString("hex");
  return withDeviceList(async (devices) => {
    const device: PhoneDevice = {
      id: crypto.randomUUID(),
      name: deviceName.trim().slice(0, 60) || "iPhone",
      tokenHash: hashToken(token),
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    devices.push(device);
    await writeDevices(devices);
    return { device: publicDevice(device), token };
  });
}

// MARK: Inbox

/** How long a clip nothing has taken stays in the inbox. The inbox is staging,
 * and a shoot nobody opened an editor for would otherwise sit here forever as a
 * second full copy of itself. */
const CLIP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a claim holds before the clip goes back in the inbox. An editor that
 * took a clip and died mid-import must not strand it, and an import still
 * running must not have it taken away — a gigabyte take through a browser is
 * minutes, not seconds. */
const CLAIM_TTL_MS = 30 * 60 * 1000;

export interface PhoneClipInput {
  takeId: string;
  fileName: string;
  capturedAt?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

/** Take a clip off a paired phone.
 *
 * The app stages each take in the system temp directory as it comes off the
 * radio, and this moves that file into the inbox under an id of this Mac's
 * choosing — a phone cannot name a path here. A move rather than a copy: a field
 * take is gigabytes, and pushing one through loopback to write it again is the
 * difference between instant and a minute. Across volumes the move falls back to
 * a copy, which is what rename cannot do there.
 *
 * The bytes land before the record, and only the record makes a clip visible, so
 * a transfer that breaks partway leaves nothing for an editor to find. The
 * start-up sweep collects what it left behind.
 */
export async function addPhoneClip(
  device: PhoneDeviceInfo,
  stagedPath: string,
  input: PhoneClipInput
): Promise<PhoneClip> {
  assertLocalRuntime();
  await mkdir(inboxRoot(), { recursive: true });

  // The same take arriving twice is the phone sending one whose acknowledgement
  // it never read. It already has a copy here.
  const already = await findPhoneClipByTake(device.id, input.takeId);
  if (already) {
    await rm(stagedClipPath(stagedPath), { force: true });
    return already;
  }

  const name = clipFileName(input.fileName);
  const id = crypto.randomUUID();
  const file = path.join(inboxRoot(), `${id}${path.extname(name)}`);

  const staged = stagedClipPath(stagedPath);
  try {
    await rename(staged, file);
  } catch {
    await copyFile(staged, file);
    await rm(staged, { force: true });
  }

  const clip: PhoneClip = {
    id,
    takeId: input.takeId,
    deviceId: device.id,
    deviceName: device.name,
    fileName: name,
    bytes: (await stat(file)).size,
    capturedAt: input.capturedAt ?? Date.now(),
    receivedAt: Date.now(),
    ...(input.durationSeconds ? { durationSeconds: input.durationSeconds } : {}),
    ...(input.width ? { width: input.width } : {}),
    ...(input.height ? { height: input.height } : {}),
  };
  await writeJsonAtomic(clipMetaPath(id), clip);
  return clip;
}

/** A take this device already delivered, whichever state its record is in. */
async function findPhoneClipByTake(deviceId: string, takeId: string): Promise<PhoneClip | null> {
  for (const clip of await allPhoneClips()) {
    if (clip.deviceId === deviceId && clip.takeId === takeId) return clip;
  }
  return null;
}

/** Every record in the inbox, claimed or not. */
async function allPhoneClips(): Promise<PhoneClip[]> {
  let names: string[];
  try {
    names = await readdir(inboxRoot());
  } catch {
    return [];
  }
  const clips = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n) => {
        try {
          return JSON.parse(await readFile(path.join(inboxRoot(), n), "utf8")) as PhoneClip;
        } catch {
          return null;
        }
      })
  );
  return clips.filter((c): c is PhoneClip => c !== null);
}

/** Everything waiting and unclaimed, oldest shot first — the order a shoot
 * happened in is the order it should land on a timeline. A record whose bytes
 * are gone is not offered; the sweep collects it. */
export async function listPhoneClips(): Promise<PhoneClip[]> {
  assertLocalRuntime();
  await releaseLapsedClaims();
  const unclaimed = (await allPhoneClips()).filter((c) => c.claimedAt === undefined);
  const present = await Promise.all(unclaimed.map((c) => exists(clipFilePath(c))));
  return unclaimed.filter((_, i) => present[i]).sort((a, b) => a.capturedAt - b.capturedAt);
}

/**
 * Take a clip, if it is still there to take.
 *
 * The rename is the whole mechanism: two editors racing both try to move the
 * same record, the filesystem performs exactly one of them, and the loser's
 * rename finds no source. Nothing is read and written back, so there is no
 * window between deciding and doing.
 */
export async function claimPhoneClip(id: string): Promise<PhoneClip | null> {
  assertLocalRuntime();
  await releaseLapsedClaims();
  const safe = safeId(id);
  let clip: PhoneClip;
  try {
    clip = JSON.parse(await readFile(clipMetaPath(safe), "utf8")) as PhoneClip;
    await rename(clipMetaPath(safe), claimedMetaPath(safe));
  } catch {
    return null;
  }
  const claimed: PhoneClip = { ...clip, claimedAt: Date.now() };
  await writeJsonAtomic(claimedMetaPath(safe), claimed);
  return claimed;
}

/** Give a claimed clip back — the import failed, and the next pass should find
 * it waiting. */
export async function releasePhoneClip(id: string): Promise<void> {
  assertLocalRuntime();
  const safe = safeId(id);
  let clip: PhoneClip;
  try {
    clip = JSON.parse(await readFile(claimedMetaPath(safe), "utf8")) as PhoneClip;
  } catch {
    return;
  }
  delete clip.claimedAt;
  await writeJsonAtomic(clipMetaPath(safe), clip);
  await rm(claimedMetaPath(safe), { force: true });
}

/** Claims whose editor never came back. */
async function releaseLapsedClaims(): Promise<void> {
  const cutoff = Date.now() - CLAIM_TTL_MS;
  for (const clip of await allPhoneClips()) {
    if (clip.claimedAt !== undefined && clip.claimedAt < cutoff) {
      await releasePhoneClip(clip.id);
    }
  }
}

/** A clip's record whether or not it has been claimed. */
export async function readPhoneClip(id: string): Promise<PhoneClip | null> {
  assertLocalRuntime();
  const safe = safeId(id);
  for (const file of [clipMetaPath(safe), claimedMetaPath(safe)]) {
    try {
      return JSON.parse(await readFile(file, "utf8")) as PhoneClip;
    } catch {
      // The other name, or neither.
    }
  }
  return null;
}

/** Where a clip's bytes sit, by its record. */
function clipFilePath(clip: PhoneClip): string {
  return path.join(inboxRoot(), `${clip.id}${path.extname(clip.fileName) || ".mov"}`);
}

/** The clip's file on disk, or null when the record or the bytes are gone. */
export async function phoneClipPath(id: string): Promise<string | null> {
  const clip = await readPhoneClip(id);
  if (!clip) return null;
  const file = clipFilePath(clip);
  return (await exists(file)) ? file : null;
}

/**
 * Move a claimed clip straight into a project's media.
 *
 * For a project that lives on this Mac both ends are local disk, so the bytes
 * never leave it: the editor asks for the move and the file is renamed into the
 * project. The alternative is the page pulling gigabytes off loopback and
 * pushing the same bytes back, which is two copies of a take through a tab that
 * has to hold the whole thing in memory.
 */
export async function movePhoneClipToProject(id: string, projectId: string): Promise<string> {
  assertLocalRuntime();
  const clip = await readPhoneClip(id);
  const file = clip ? clipFilePath(clip) : null;
  if (!clip || !file || !(await exists(file))) throw new Error("That clip is gone.");

  await mkdir(mediaDir(projectId), { recursive: true });
  const base = path.basename(clip.fileName).replace(/[^\w.\-() ]+/g, "_").slice(-80);
  const fileName = await uniqueName(base, (n) => mediaPath(projectId, n));
  const destination = mediaPath(projectId, fileName);
  try {
    await rename(file, destination);
  } catch {
    await copyFile(file, destination);
    await rm(file, { force: true });
  }
  await rm(claimedMetaPath(safeId(id)), { force: true });
  await rm(clipMetaPath(safeId(id)), { force: true });
  return fileName;
}

/** Drop a clip once an editor has it: the record and the bytes together. */
export async function removePhoneClip(id: string): Promise<void> {
  assertLocalRuntime();
  const file = await phoneClipPath(id);
  if (file) await rm(file, { force: true });
  await rm(clipMetaPath(safeId(id)), { force: true });
  await rm(claimedMetaPath(safeId(id)), { force: true });
}

/**
 * Clear what the inbox should not be holding, run once as the engine starts.
 *
 * Three kinds of leftovers: bytes with no record, from a transfer that broke
 * before the record was written; records whose bytes are gone; and clips older
 * than the inbox keeps, which is every take from a shoot nobody opened an editor
 * for.
 */
export async function sweepPhoneInbox(): Promise<void> {
  assertLocalRuntime();
  let names: string[];
  try {
    names = await readdir(inboxRoot());
  } catch {
    return;
  }

  const cutoff = Date.now() - CLIP_TTL_MS;
  const keeping = new Set<string>();
  for (const clip of await allPhoneClips()) {
    if (clip.receivedAt < cutoff || !(await exists(clipFilePath(clip)))) {
      await removePhoneClip(clip.id);
      continue;
    }
    keeping.add(path.basename(clipFilePath(clip)));
  }

  for (const name of names) {
    if (name.endsWith(".json") || keeping.has(name)) continue;
    await rm(path.join(inboxRoot(), name), { force: true });
  }

  await releaseLapsedClaims();
}

/** Clip ids are ours — uuids — so anything else is a path probe. */
function safeId(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Bad clip id.");
  return id;
}

/** A staged clip is one the app just wrote to the system temp directory. The
 * engine answers on loopback with no auth, so it takes a path from that caller
 * only where the app puts them, and nowhere else on the disk. */
function stagedClipPath(raw: string): string {
  const resolved = path.resolve(raw);
  const staging = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(staging)) throw new Error("A staged clip lives in the temp directory.");
  return resolved;
}

/** The name a clip lands under, reduced to a leaf this Mac is willing to write:
 * the phone names its own takes, and a name is not a path. */
function clipFileName(raw: string): string {
  const leaf = path.basename(raw ?? "").replace(/[/\\]/g, "").trim();
  const ext = path.extname(leaf) || ".mov";
  const stem = leaf.slice(0, leaf.length - path.extname(leaf).length) || "clip";
  return `${stem.slice(0, 80)}${ext}`;
}
