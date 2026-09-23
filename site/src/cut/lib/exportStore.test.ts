import { afterEach, expect, spyOn, test } from "bun:test";
import * as backend from "@/cut/lib/backend";
import * as exportClient from "@/cut/lib/exportClient";
import * as exportRender from "@/cut/lib/exportRender";
import { EXPORT_PRESETS } from "@/cut/lib/exportPresets";
import { exportBackend, exportCancelable, useExports, type ExportJob, type LocalRow } from "@/cut/lib/exportStore";
import { useEditor } from "@/cut/lib/store";

const initial = useExports.getState();
const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  useExports.setState(initial, true);
});

function feed(jobs: ExportJob[] = []) {
  const online = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  restores.push(() => {
    if (online) Object.defineProperty(navigator, "onLine", online);
    else Reflect.deleteProperty(navigator, "onLine");
  });
  for (const residency of ["browser", "local", "cloud"] as const) {
    const mock = spyOn(exportBackend(residency), "fetch").mockImplementation(async () =>
      Response.json(jobs.filter((job) => job.residency === residency))
    );
    restores.push(() => mock.mockRestore());
  }
}

for (const residency of ["browser", "local", "cloud"] as const) {
  test(`${residency}: hiding a tab render preserves progress and explicit cancellation`, async () => {
    const row: LocalRow = {
      id: "local-render", projectId: "project", residency, status: "rendering",
      progress: 0.25, createdAt: 1, abort: new AbortController(),
    };
    useExports.setState({ local: [row] });
    useExports.getState().dismiss(row.id);
    expect(row.abort!.signal.aborted).toBe(false);
    expect(useExports.getState().local).toEqual([row]);
    expect(useExports.getState().dismissed).toContain(row.id);
    expect(exportCancelable({ kind: "local", data: row })).toBe(true);

    feed([{ id: "other", projectId: "other", residency: "browser", status: "running", progress: 0.5 }]);
    await useExports.getState().refresh();
    expect(useExports.getState().dismissed).toContain(row.id);
    expect(useExports.getState().local[0].progress).toBe(0.25);

    useExports.getState().cancel(row.id);
    expect(row.abort!.signal.aborted).toBe(true);
    expect(useExports.getState().local).toEqual([]);
  });
}

test("hiding preparation keeps its row until the export starts", () => {
  const row: LocalRow = {
    id: "local-preparing", projectId: "project", residency: "local", status: "preparing", createdAt: 1,
  };
  useExports.setState({ local: [row] });
  useExports.getState().dismiss(row.id);
  expect(useExports.getState().local).toEqual([row]);
  expect(useExports.getState().dismissed).toContain(row.id);
});

test("a hidden tab render stays hidden when its finished job reaches the feed", async () => {
  const probe = spyOn(exportRender, "canRenderInBrowser").mockResolvedValue(true);
  restores.push(() => probe.mockRestore());
  const render = spyOn(exportClient, "runBrowserExport").mockImplementation(async (_project, _doc, _settings, opts) => {
    opts?.onClaimed?.("finished");
    const row = useExports.getState().local[0];
    useExports.getState().dismiss(row.id);
    opts?.onProgress?.(0.75);
    expect(useExports.getState().local[0].progress).toBe(0.75);
    expect(opts?.signal?.aborted).toBe(false);
    return "finished";
  });
  restores.push(() => render.mockRestore());
  feed([{ id: "finished", projectId: "project", residency: "browser", status: "done", progress: 1 }]);

  await useExports.getState().start("project", useEditor.getState(), {
    width: 1280, height: 720, ...EXPORT_PRESETS[0].settings,
  });
  expect(render).toHaveBeenCalled();
  expect(useExports.getState().local).toEqual([]);
  expect(useExports.getState().rendering).toEqual([]);
  expect(useExports.getState().dismissed).toEqual(["finished"]);
  expect(useExports.getState().jobs[0].status).toBe("done");
});

test("dismissing a local error removes the settled row", () => {
  useExports.setState({ local: [{
    id: "failed", projectId: "project", residency: "browser", status: "error", createdAt: 1,
  }] });
  useExports.getState().dismiss("failed");
  expect(useExports.getState().local).toEqual([]);
});

test("hidden preparation stays hidden when the worker queues its job", async () => {
  const mode = spyOn(backend, "getBackend").mockReturnValue(exportBackend("cloud"));
  const probe = spyOn(exportRender, "canRenderInBrowser").mockResolvedValue(false);
  restores.push(() => mode.mockRestore(), () => probe.mockRestore());
  const create = spyOn(exportClient, "createExportJob").mockImplementation(async () => {
    const row = useExports.getState().local[0];
    expect(row.status).toBe("preparing");
    useExports.getState().dismiss(row.id);
    expect(useExports.getState().local).toEqual([row]);
    return "queued";
  });
  restores.push(() => create.mockRestore());
  feed([{ id: "queued", projectId: "project", residency: "cloud", status: "queued", progress: 0 }]);

  await useExports.getState().start("project", useEditor.getState(), {
    width: 1280, height: 720, ...EXPORT_PRESETS[0].settings,
  });
  expect(create).toHaveBeenCalled();
  expect(useExports.getState().local).toEqual([]);
  expect(useExports.getState().rendering).toEqual([]);
  expect(useExports.getState().dismissed).toEqual(["queued"]);
  expect(useExports.getState().jobs[0].status).toBe("queued");
});
