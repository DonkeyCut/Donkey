import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "playwright";

/** Mount real editor components and styles with an in-memory document. */
export async function componentFixture(entrypoint: string) {
  const site = path.resolve(import.meta.dir, "../../..");
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, entrypoint)],
    target: "browser", define: { "process.env.NODE_ENV": JSON.stringify("development") },
  });
  assert(build.success, build.logs.join("\n"));
  const js = await build.outputs.find((o) => o.path.endsWith(".js"))!.text();
  const from = path.join(site, "src/app/globals.css");
  const css = await postcss([tailwind({ base: site })]).process(await readFile(from, "utf8"), { from });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (error) => console.error(error));
  await page.route("http://preview.localhost/**", (route) => {
    const resource = new URL(route.request().url()).pathname;
    if (resource === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: js });
    if (resource === "/fixture.css") return route.fulfill({ contentType: "text/css", body: css.css });
    return route.fulfill({ contentType: "text/html", body: '<html><head><link rel="stylesheet" href="/fixture.css"><style>#root{height:900px;display:grid}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>' });
  });
  return { browser, page };
}
