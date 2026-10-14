import { expect, test } from "bun:test";
import { audioAsWords } from "./heardWords";

const sound = `data:audio/wav;base64,${Buffer.from("RIFF....WAVE").toString("base64")}`;
// Bytes of an ADTS AAC frame, labelled the way a whole file served as
// octet-stream comes back.
const adts = `data:audio/aac;base64,${Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc]).toString("base64")}`;

test("a listen reaches a text model as the words over the stretch, in source seconds", async () => {
  const asked: { bytes: number; locale?: string; duration?: number; fileName?: string }[] = [];
  const out = await audioAsWords(
    { name: "take.mov", from: 10, coveredTo: 14, locale: "ko-KR", audio: sound },
    async (audio, opts) => {
      asked.push({ bytes: audio.byteLength, ...opts });
      return [{ id: "c", start: 0.5, end: 1.25, text: "안녕하세요", words: [] }];
    }
  );
  expect(asked).toEqual([{ bytes: 12, locale: "ko-KR", duration: 4, fileName: "span.wav" }]);
  expect(out).toMatchObject({ name: "take.mov", from: 10, coveredTo: 14, words: [{ start: 10.5, end: 11.25, text: "안녕하세요" }] });
  expect(JSON.stringify(out)).not.toContain(sound);
});

test("a result with no sound passes through untouched", async () => {
  const output = { duration: 10, imagesOmitted: true };
  expect(await audioAsWords(output, async () => [])).toBe(output);
});

test("the container is read off the bytes", async () => {
  const names: (string | undefined)[] = [];
  const transcribe = async (_audio: Uint8Array, opts: { fileName?: string }) => {
    names.push(opts.fileName);
    return [];
  };
  await audioAsWords({ from: 0, coveredTo: 1, audio: adts }, transcribe);
  const ogg = `data:audio/aac;base64,${Buffer.from("OggS\0\0\0\0").toString("base64")}`;
  const refused = await audioAsWords({ from: 0, coveredTo: 1, audio: ogg }, transcribe).then(() => "", (e: Error) => e.message);
  expect(names).toEqual(["span.aac"]);
  expect(refused).toContain("can't be transcribed");
});
