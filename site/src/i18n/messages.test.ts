import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { TYPE, parse, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";

import { LOCALES } from "@/i18n/locales";
import { NAMESPACES } from "@/i18n/namespaces";

const DIR = new URL("./messages/", import.meta.url);

type Tree = { [key: string]: string | Tree };

const read = (locale: string, namespace: string): Tree =>
  JSON.parse(readFileSync(new URL(`${locale}/${namespace}.json`, DIR), "utf8")) as Tree;

// Every leaf as "a.b.c" → message.
function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.set(path, value);
      continue;
    }
    for (const [leaf, message] of flatten(value, path)) out.set(leaf, message);
  }
  return out;
}

// The arguments a message takes and how it uses each: "count:plural",
// "name:argument", "b:tag". A translation must take the same ones, or the
// call site's values land nowhere.
function argumentsOf(message: string): string[] {
  const found = new Set<string>();
  const walk = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      if (element.type === TYPE.argument) found.add(`${element.value}:argument`);
      if (element.type === TYPE.number) found.add(`${element.value}:number`);
      if (element.type === TYPE.date) found.add(`${element.value}:date`);
      if (element.type === TYPE.time) found.add(`${element.value}:time`);
      if (element.type === TYPE.tag) {
        found.add(`${element.value}:tag`);
        walk(element.children);
      }
      if (element.type === TYPE.plural || element.type === TYPE.select) {
        found.add(`${element.value}:${element.type === TYPE.plural ? "plural" : "select"}`);
        for (const option of Object.values(element.options)) walk(option.value);
      }
    }
  };
  walk(parse(message));
  return [...found].sort();
}

test("the namespace list names every English catalog file", () => {
  const files = readdirSync(new URL("en/", DIR))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  expect(files).toEqual([...NAMESPACES].sort());
});

for (const namespace of NAMESPACES) {
  const english = flatten(read("en", namespace));

  test(`every English ${namespace} message parses`, () => {
    for (const message of english.values()) expect(() => parse(message)).not.toThrow();
  });

  describe(namespace, () => {
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      test(`${locale} has every English key, with the same arguments`, () => {
        const translated = flatten(read(locale, namespace));
        expect([...translated.keys()].sort()).toEqual([...english.keys()].sort());
        for (const [key, message] of english) {
          expect({ key, args: argumentsOf(translated.get(key)!) }).toEqual({ key, args: argumentsOf(message) });
        }
      });
    }
  });
}
