import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { widgetHtml } from "../src/clients/chatgpt/widget.generated";

const root = path.resolve(import.meta.dir, "..");
const scratch = await mkdtemp(path.join(os.tmpdir(), "donkey-chatgpt-widget-"));
const video = path.join(scratch, "preview.mp4");
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=24", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video]);
const server = Bun.serve({ port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/widget") return new Response(widgetHtml(url.origin), { headers: { "Content-Type": "text/html" } });
  if (url.pathname === "/preview.mp4") return new Response(Bun.file(video));
  if (url.pathname === "/embed") return new Response(`<!doctype html><title>editor</title><p id="editor">Editor for ${url.searchParams.get("project")} via ${url.searchParams.get("code")}</p>`, { headers: { "Content-Type": "text/html" } });
  if (url.pathname.startsWith("/clients/chatgpt/")) return new Response(Bun.file(path.join(root, "public/clients/chatgpt", path.basename(url.pathname))));
  return new Response(hostHtml, { headers: { "Content-Type": "text/html" } });
} });
const hostHtml = `<!doctype html><html><body><iframe title="Donkey Cut preview" src="/widget" style="width:700px;height:700px;border:0"></iframe><script>
const frame = document.querySelector('iframe');
const project = {id:'project',name:'Launch film',revision:'cloud:2',url:'https://donkeycut.com/app/p/project'};
let count = 0, renewals = 0;
window.calls = []; window.links = []; window.modes = []; window.editable = false;
const view = (selected, preview = null) => ({view:selected?'project':'projects',projects:selected?[]:[project],nextCursor:null,project:selected?project:null,preview,canRender:true,canEdit:window.editable,export:null,job:null,results:[],changed:false,history:null,account:null});
// ChatGPT's sandbox drops null-valued keys before the widget sees a result.
const dropNulls = (value) => Array.isArray(value) ? value.map(dropNulls) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)])) : value;
const result = (data, playback = null, editor = null) => dropNulls({content:[{type:'text',text:'Preview'}],structuredContent:data,_meta:{playback,editor,pollMs:1000}});
const reply = (id, result) => frame.contentWindow.postMessage({jsonrpc:'2.0',id,result},'*');
window.addEventListener('message', ({source,data}) => {
 if(source !== frame.contentWindow || !data.method) return;
 if(data.method === 'ui/initialize') reply(data.id,{protocolVersion:data.params.protocolVersion,hostInfo:{name:'fixture',version:'1'},hostCapabilities:{serverTools:{},openLinks:{}},hostContext:{theme:'light',availableDisplayModes:['inline','fullscreen']}});
 if(data.method === 'ui/notifications/initialized') frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result(view(false))},'*');
 if(data.method === 'tools/call') {
  const name = data.params.name; window.calls.push(name);
  if(name === 'list_projects') reply(data.id,result(view(false)));
  if(name === 'open_project') reply(data.id, window.editable ? result(view(true),null,{url:location.origin+'/embed?code=one-use&project=project',expiresAt:Date.now()+60000}) : result(view(true)));
  if(name === 'render_preview') { count=0; reply(data.id,result(view(true,{id:'job',status:'queued',progress:0,revision:'cloud:2'}))); }
  if(name === 'get_preview_status') {
   count++; const done = count >= 3;
   reply(data.id,result(view(true,{id:'job',status:done?'done':'running',progress:done?1:count/3,revision:'cloud:2'}),done?{url:location.origin+'/preview.mp4?v='+renewals++,expiresAt:Date.now()+3600000}:null));
  }
 }
 if(data.method === 'ui/open-link') { window.links.push(data.params.url); reply(data.id,{}); }
 if(data.method === 'ui/request-display-mode') { window.modes.push(data.params.mode); reply(data.id,{mode:data.params.mode}); }
});
</script></body></html>`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [], requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`http://localhost:${server.port}`);
  const app = page.frameLocator("iframe");
  await app.getByRole("button", { name: "Launch film" }).click();
  await app.getByRole("button", { name: "Render preview", exact: true }).click();
  await app.locator("video").waitFor();
  const frame = page.frames().find((f) => f.url().endsWith("/widget"))!;
  await frame.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 2);
  const calls = await page.evaluate(() => (window as unknown as { calls: string[] }).calls);
  assert.equal(calls.filter((name) => name === "get_preview_status").length, 3, "poll through repeated running states");
  assert.equal(requests.some((url) => url.includes("/hls-")), false, "MP4 must not download HLS");
  await frame.evaluate(() => document.querySelector("video")!.dispatchEvent(new Event("error")));
  await frame.waitForFunction(() => document.querySelector("video")?.src.endsWith("v=1"));
  await frame.evaluate(async () => { const video = document.querySelector("video")!; video.muted = true; await video.play(); });
  await frame.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await frame.waitForFunction(() => document.querySelector("video")?.paused === true);
  await frame.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
  await app.getByRole("button", { name: "Open in Donkey Cut" }).click();
  await page.waitForFunction(() => (window as unknown as { links: string[] }).links.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { links: string[] }).links), ["https://donkeycut.com/app/p/project"]);
  await page.screenshot({ path: "/tmp/donkey-chatgpt-widget.png" });
  await app.getByRole("button", { name: "Projects", exact: true }).click();
  await app.locator("video").waitFor({ state: "detached" });
  assert.equal(await app.locator("video").count(), 0, "project picker releases the video");
  await page.evaluate(() => { (window as unknown as { editable: boolean }).editable = true; });
  await app.getByRole("button", { name: "Launch film" }).click();
  await app.frameLocator("iframe.editor").locator("#editor").waitFor();
  assert.equal(await app.locator("button").count(), 0, "the editor card has no buttons of its own");
  assert.deepEqual(await page.evaluate(() => (window as unknown as { modes: string[] }).modes), ["fullscreen"], "the editor asks for the whole window");
  await page.screenshot({ path: "/tmp/donkey-chatgpt-widget-editor.png" });
  assert.deepEqual(errors, []);
  console.log("PASS: project selection, repeated polling, native playback, URL recovery, hidden pause, Open in Donkey Cut, editor in the card, decoder teardown, lazy HLS.");
} finally {
  await browser.close(); server.stop(true); await rm(scratch, { recursive: true, force: true });
}
