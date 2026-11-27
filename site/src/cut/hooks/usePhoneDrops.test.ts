import { beforeEach, expect, test } from "bun:test";

import { useEditor } from "@/cut/lib/store";

import { importStored, type ProjectImport } from "./usePhoneDrops";

const file = new File([new Uint8Array(4)], "clip.mp4", { type: "video/mp4" });

/** An import that places `assetId` in the store, or refuses the file. */
const importing =
  (assetId: string | null): ProjectImport =>
  async (files, opts) => {
    if (!assetId) {
      opts.onOutcome({ file: files[0], failed: true });
      return;
    }
    useEditor.setState({ assets: [{ id: assetId } as never] });
    opts.onOutcome({ file: files[0], assetId });
  };

beforeEach(() => {
  useEditor.setState({ projectId: "p1", assets: [] });
});

test("a file in project storage has landed", async () => {
  expect(await importStored(importing("a1"), file, null)).toBe("landed");
});

test("a file the import refuses is refused", async () => {
  expect(await importStored(importing(null), file, null)).toBe("refused");
});

test("leaving the project keeps the staged copy for another pass", async () => {
  const leaving: ProjectImport = async (files, opts) => {
    await importing("a1")(files, opts);
    useEditor.setState({ projectId: "p2", assets: [] });
  };
  expect(await importStored(leaving, file, null)).toBe("again");
});
