import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchSuggestions } from "./SearchSuggestions";

// A frame whose document takes neither theme gets an opaque canvas from the
// browser whenever the page is dark, which shows white around the chips.
test("the suggestion frame takes the page's light or dark theme", () => {
  const output = { display: { searchSuggestions: ['<div class="container">chips</div>'] } };
  const html = renderToStaticMarkup(<SearchSuggestions output={output} />);
  const doc = /srcDoc="([^"]*)"/i.exec(html)?.[1].replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">") ?? "";
  expect(doc).toContain('<meta name="color-scheme" content="light dark">');
});
