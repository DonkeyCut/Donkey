import { describe, expect, test } from "bun:test";
import { CUT_MEDIA_ORIGIN, STOCK_AUDIO_PUBLIC_KEY } from "./hosts";
import { STOCK_MUSIC } from "./stockMusicManifest";
import { STOCK_SFX } from "./stockSfxManifest";

// Every bundled sound is fetched by the card with no token, so its file has to
// be a key the media Worker serves as public. A manifest row outside that
// shape is a card that plays silence.
describe("stock audio manifests", () => {
  test("every file is a public media key", () => {
    for (const row of [...STOCK_SFX, ...STOCK_MUSIC]) {
      expect(row.file.startsWith(`${CUT_MEDIA_ORIGIN}/`)).toBe(true);
      expect(STOCK_AUDIO_PUBLIC_KEY.test(row.file.slice(CUT_MEDIA_ORIGIN.length + 1))).toBe(true);
    }
  });
});
