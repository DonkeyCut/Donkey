import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { EmailAuthForm } from "./_components/landing/EmailAuthForm";
import { EditorMock } from "@/cut/components/editor-mock/EditorMock";
import { CreditsSlide } from "@/cut/components/onboarding/slides/Credits";

type Theme = "light" | "dark";
type Color = [number, number, number, number];
const css = postcss.parse(readFileSync(new URL("./globals.css", import.meta.url), "utf8"));
const tokens: Record<Theme, Map<string, string>> = { light: new Map(), dark: new Map() };
const colors = new Map([["white", "#ffffff"], ["black", "#000000"]]);
css.walkAtRules("theme", (rule) => {
  rule.walkDecls((decl) => { colors.set(decl.prop.replace("--color-", ""), decl.value); });
});
css.walkRules((rule) => {
  const theme = rule.selector === ":root" ? "light" : rule.selector === ".dark" ? "dark" : null;
  if (theme) { rule.walkDecls((decl) => { tokens[theme].set(decl.prop, decl.value); }); }
});

// Sample the actual components' color utilities against the repository palette.
// These guards supplement browser checks; they do not implement a CSS cascade.
function colorOf(name: string, theme: Theme): Color | null {
  const [key, opacity = "100"] = name.split("/");
  let value = colors.get(key) ?? (key.startsWith("[#") ? key.slice(1, -1) : "");
  while (value.startsWith("var(")) {
    const token = value.slice(4, -1);
    value = tokens[theme].get(token) ?? tokens.light.get(token) ?? "";
  }
  if (value.startsWith("#")) {
    const hex = value.length === 4 ? value.slice(1).split("").map((c) => c + c).join("") : value.slice(1);
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).concat(Number(opacity) / 100) as Color;
  }
  const neutral = value.match(/^oklch\(([\d.]+) 0 0\)$/);
  if (!neutral) { return null; }
  const linear = Number(neutral[1]) ** 3;
  const channel = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  return [channel, channel, channel, Number(opacity) / 100];
}

function over(color: Color, background: Color): Color {
  return [0, 1, 2].map((i) => color[i] * color[3] + background[i] * (1 - color[3])).concat(1) as Color;
}

function paint(element: Pick<Element, "className">, prefix: string, theme: Theme, state = ""): Color {
  const classes = element.className.split(/\s+/);
  const pick = (start: string) => classes.filter((c) => c.startsWith(start)).map((c) => colorOf(c.slice(start.length), theme)).filter((c): c is Color => c !== null).at(-1);
  const result = (state ? pick(state + prefix) : null) ?? pick(prefix);
  if (!result) { throw new Error(`Missing color for ${state}${prefix}: ${element.className}`); }
  return result;
}

function contrast(a: Color, b: Color): number {
  const luminance = (color: Color) => color.slice(0, 3).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}

const pageColor = (theme: Theme) => colorOf("background", theme)!;

test("auth input focus stays distinguishable on its card in both themes", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const mode of ["sign-in", "sign-up"] as const) {
      const { document } = parseHTML(renderToStaticMarkup(<EmailAuthForm mode={mode} />));
      for (const input of document.querySelectorAll("input")) {
        const background = over(paint(input, "bg-", theme), pageColor(theme));
        expect(contrast(over(paint(input, "border-", theme, "focus:"), background), background)).toBeGreaterThanOrEqual(3);
      }
    }
  }
});

test("showcase labels remain readable in resting, selected and hover states", () => {
  const { document } = parseHTML(renderToStaticMarkup(<EditorMock />));
  const buttons = document.querySelectorAll("button[aria-pressed]");
  expect(buttons.length).toBeGreaterThan(1);
  for (const theme of ["light", "dark"] as const) {
    for (const button of buttons) {
      for (const state of ["", "hover:"]) {
        const background = over(paint(button, "bg-", theme, state), pageColor(theme));
        expect(contrast(over(paint(button, "text-", theme, state), background), background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

test("credit expiry text remains readable against both onboarding surfaces", () => {
  const { document } = parseHTML(renderToStaticMarkup(<CreditsSlide credits="5" expiresAt="2026-11-01T00:00:00Z" />));
  const expiry = Array.from(document.querySelectorAll("p")).find((p) => p.textContent?.startsWith("Expires "))!;
  expect(expiry).toBeDefined();
  for (const theme of ["light", "dark"] as const) {
    const background = theme === "light" ? colorOf("cream", theme)! : pageColor(theme);
    expect(contrast(over(paint(expiry, "text-", theme), background), background)).toBeGreaterThanOrEqual(4.5);
  }
});

test("article loading bars remain visible against both blog surfaces", () => {
  // Inspect the private fallback without executing its server data reads.
  const text = readFileSync(new URL("./cut/blog/[slug]/page.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("page.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = source.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "PostSkeleton")!;
  const bars: { className: string }[] = [];
  function visit(child: ts.Node): void {
    if (ts.isJsxAttribute(child) && child.name.getText(source) === "className" && child.initializer && ts.isStringLiteral(child.initializer)) {
      const classes = child.initializer.text;
      if (classes.split(/\s+/).some((c) => c === "h-4" || c === "h-10")) {
        bars.push({ className: classes });
      }
    }
    child.forEachChild(visit);
  }
  node.forEachChild(visit);
  expect(bars.length).toBe(4);
  for (const theme of ["light", "dark"] as const) {
    const background = pageColor(theme);
    for (const bar of bars) {
      // A visibility regression guard for decoration, separate from text AA.
      expect(contrast(over(paint(bar, "bg-", theme), background), background)).toBeGreaterThan(1.2);
    }
  }
});
