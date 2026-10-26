import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailAuthForm } from "./_components/landing/EmailAuthForm";
import { MentionTextarea } from "@/cut/components/AssetRefs";
import { AiChatSlide } from "@/cut/components/onboarding/slides/AiChat";
import { TopNav } from "./_components/landing/TopNav";

const css = postcss.parse(readFileSync(new URL("./globals.css", import.meta.url), "utf8"));

// Theme declarations must reach a cold page before any client code runs.
describe("dark theme", () => {
  test("the navigation mark keeps its dark artwork on a white tile", () => {
    const html = renderToStaticMarkup(createElement(TopNav));
    expect(html.includes("/donkey-logo.svg")).toBe(true);
    expect(html.includes("dark:bg-white")).toBe(true);
  });

  test("onboarding copy has a scrim matching the dark surface", () => {
    const html = renderToStaticMarkup(createElement(AiChatSlide));
    expect(html.includes("dark:from-background")).toBe(true);
    expect(html.includes("dark:via-background/85")).toBe(true);
  });

  test("generation prompt hints use the theme's readable text color", () => {
    const html = renderToStaticMarkup(createElement(MentionTextarea, {
      value: "", candidates: [], onChange: () => {}, placeholder: "Describe a shot",
    }));
    expect(html.match(/<textarea[^>]+class="([^"]+)"/)?.[1]).toContain("placeholder:text-muted-foreground");
  });

  test("email auth actions use a paired foreground and surface", () => {
    for (const mode of ["sign-in", "sign-up"] as const) {
      const html = renderToStaticMarkup(createElement(EmailAuthForm, { mode }));
      const button = html.match(/<button[^>]+class="([^"]+)"/)?.[1];
      expect(button).toContain("bg-primary");
      expect(button).toContain("text-primary-foreground");
    }
  });

  test("system dark mode supplies foreground and surface tokens", () => {
    const tokens = new Map<string, string>();
    css.walkAtRules("media", (media) => {
      if (media.params !== "(prefers-color-scheme: dark)") {
        return;
      }
      media.walkDecls((declaration) => {
        tokens.set(declaration.prop, declaration.value);
      });
    });
    expect(tokens.get("--foreground")).toBe("oklch(0.985 0 0)");
    expect(tokens.get("--background")).toBe("oklch(0.145 0 0)");
    expect(tokens.get("--card")).toBe("oklch(0.205 0 0)");
  });

  test("the product surface respects the selected theme", () => {
    const overrides: string[] = [];
    css.walkRules((rule) => {
      if (rule.selector.includes("html:has(.app-surface)")) {
        rule.walkDecls("--background", (declaration) => {
          overrides.push(declaration.value);
        });
      }
    });
    expect(overrides).toEqual(["var(--app-background)"]);
  });
});
