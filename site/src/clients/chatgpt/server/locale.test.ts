import { expect, test } from "bun:test";
import { escapeHtml, mcpLocale, requestLocale } from "./locale";

const page = (headers: Record<string, string>) => new Request("https://donkeycut.com/api/chatgpt/embed", { headers });
const rpc = (body: unknown) =>
  new Request("https://donkeycut.com/api/chatgpt/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("a page reads the saved language first, then Accept-Language", () => {
  expect(requestLocale(page({ cookie: "a=1; NEXT_LOCALE=ko", "accept-language": "fr" }))).toBe("ko");
  expect(requestLocale(page({ cookie: "NEXT_LOCALE=xx", "accept-language": "pt-PT,pt;q=0.9" }))).toBe("pt-BR");
  expect(requestLocale(page({}))).toBe("en");
});

test("an MCP request speaks the locale ChatGPT names in _meta", async () => {
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "undo", _meta: { "openai/locale": "ja-JP" } } };
  expect(await mcpLocale(rpc(call), "owner")).toBe("ja");
  const older = { jsonrpc: "2.0", id: 1, method: "initialize", params: { _meta: { "webplus/i18n": "de-AT" } } };
  expect(await mcpLocale(rpc([older]), "owner")).toBe("de");
});

test("page text is escaped before it reaches the HTML", () => {
  expect(escapeHtml(`<b class="x">'&'</b>`)).toBe("&lt;b class=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/b&gt;");
});
