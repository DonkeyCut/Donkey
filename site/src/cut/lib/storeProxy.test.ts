import { afterEach, describe, expect, mock, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { MediaAsset } from "./types";

const deletes: string[] = [];
await stubModule("./backend", import.meta.url, {
  apiFetch: mock(async (path: string, init?: RequestInit) => {
    if (init?.method === "DELETE") deletes.push(path);
    return Response.json({ ok: true });
  }),
});
const { useEditor } = await import("./store");

const master = (id: string, proxy?: MediaAsset["proxy"]): MediaAsset => ({
  id,
  fileName: `${id}.MOV`,
  name: `${id}.MOV`,
  type: "video",
  duration: 4,
  url: `https://example.test/${id}.MOV`,
  ...(proxy ? { proxy, proxyUrl: `https://example.test/${proxy.fileName}` } : {}),
});

afterEach(() => {
  deletes.length = 0;
  useEditor.setState({ projectId: null, assets: [], clips: [], audioClips: [], readOnly: false });
});

describe("a ProRes master's proxy in the store", () => {
  test("setAssetProxy writes the proxy and its address onto the asset, in the saved projection", () => {
    useEditor.setState({ projectId: "p", assets: [master("a")] });
    useEditor.getState().setAssetProxy("a", { fileName: "a.proxy.mp4", sizeBytes: 12 }, "blob:proxy");
    const asset = useEditor.getState().assets[0];
    expect(asset.proxy).toEqual({ fileName: "a.proxy.mp4", sizeBytes: 12 });
    expect(asset.proxyUrl).toBe("blob:proxy");
  });

  test("a read-only view takes no proxy", () => {
    useEditor.setState({ projectId: "p", assets: [master("a")], readOnly: true });
    useEditor.getState().setAssetProxy("a", { fileName: "a.proxy.mp4", sizeBytes: 12 }, "blob:proxy");
    expect(useEditor.getState().assets[0].proxy).toBeUndefined();
  });

  test("deleting the asset drops the master and its proxy", () => {
    useEditor.setState({ projectId: "p", assets: [master("a", { fileName: "a.proxy.mp4", sizeBytes: 12 })] });
    useEditor.getState().removeAsset("a");
    expect(useEditor.getState().assets).toHaveLength(0);
    expect(deletes).toEqual(["/api/cut/projects/p/media/a.MOV", "/api/cut/projects/p/media/a.proxy.mp4"]);
  });

  test("a proxy another asset still points at stays", () => {
    const proxy = { fileName: "a.proxy.mp4", sizeBytes: 12 };
    useEditor.setState({
      projectId: "p",
      assets: [master("a", proxy), { ...master("b", proxy), fileName: "a.MOV" }],
    });
    useEditor.getState().removeAsset("a");
    expect(deletes).toEqual([]);
  });
});
