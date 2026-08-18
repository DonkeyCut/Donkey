import { expect, test } from "bun:test";

import { fontsFromArchive, isFontArchive } from "./fontArchive";

type Bytes = Uint8Array<ArrayBuffer>;

interface Entry {
  name: string;
  body: Bytes;
  deflated?: Bytes;
}

async function deflate(bytes: Bytes): Promise<Bytes> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A zip, built by hand: the reader ignores CRCs and timestamps, so they stay
 * zero and the fixture stays readable. */
function zip(entries: Entry[]): File {
  const enc = new TextEncoder();
  const locals: Bytes[] = [];
  const central: Bytes[] = [];
  let at = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const stored = e.deflated ?? e.body;
    const local = new Uint8Array(30 + name.length + stored.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, e.deflated ? 8 : 0, true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, e.body.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(stored, 30 + name.length);
    locals.push(local);

    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(10, e.deflated ? 8 : 0, true);
    dv.setUint32(20, stored.length, true);
    dv.setUint32(24, e.body.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, at, true);
    dir.set(name, 46);
    central.push(dir);
    at += local.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, at, true);
  return new File([...locals, ...central, end], "download.zip", { type: "application/zip" });
}

const bytes = (s: string) => new TextEncoder().encode(s) as Bytes;

test("a zip is recognized by extension or type", () => {
  expect(isFontArchive(new File([], "Imperial_Script.zip"))).toBe(true);
  expect(isFontArchive(new File([], "font.ttf"))).toBe(false);
});

test("takes one face per family and leaves the licence behind", async () => {
  const out = await fontsFromArchive(
    zip([
      { name: "Imperial_Script/OFL.txt", body: bytes("licence") },
      { name: "Imperial_Script/ImperialScript-Bold.ttf", body: bytes("bold") },
      { name: "Imperial_Script/ImperialScript-Regular.ttf", body: bytes("regular") },
      { name: "__MACOSX/._ImperialScript-Regular.ttf", body: bytes("junk") },
    ])
  );
  expect(out.map((f) => f.name)).toEqual(["ImperialScript-Regular.ttf"]);
  expect(await out[0].text()).toBe("regular");
});

test("a variable font wins over the static faces beside it", async () => {
  const out = await fontsFromArchive(
    zip([
      { name: "static/Montserrat-Regular.ttf", body: bytes("static") },
      { name: "Montserrat-VariableFont_wght.ttf", body: bytes("variable") },
    ])
  );
  expect(out).toHaveLength(1);
  expect(await out[0].text()).toBe("variable");
});

test("separate families each keep a face", async () => {
  const out = await fontsFromArchive(
    zip([
      { name: "Inter-Regular.otf", body: bytes("inter") },
      { name: "Lora-Regular.otf", body: bytes("lora") },
    ])
  );
  expect(out.map((f) => f.name).sort()).toEqual(["Inter-Regular.otf", "Lora-Regular.otf"]);
});

test("reads a deflated entry", async () => {
  const body = bytes("font bytes ".repeat(40));
  const out = await fontsFromArchive(
    zip([{ name: "Cera-Regular.ttf", body, deflated: await deflate(body) }])
  );
  expect(await out[0].text()).toBe(new TextDecoder().decode(body));
});

test("a file that is not a zip yields nothing", async () => {
  expect(await fontsFromArchive(new File([bytes("not a zip")], "x.zip"))).toEqual([]);
});
