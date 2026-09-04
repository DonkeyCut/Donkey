import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defaultSettings, defineSettings, publicSettingKeys, publicSubset, resolveSettings } from "./settings";

const registry = defineSettings({
  greeting: { schema: z.enum(["short", "long"]), default: "short", public: true, title: "Greeting", description: "" },
  serverOnly: { schema: z.boolean(), default: false, public: false, title: "Server", description: "" },
});

describe("settings", () => {
  test("a default the schema rejects fails at definition", () => {
    let threw = false;
    try {
      defineSettings({ bad: { schema: z.number(), default: "x" as never, public: true, title: "", description: "" } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("the public subset carries only public keys", () => {
    expect(publicSettingKeys(registry)).toEqual(["greeting"]);
    expect(publicSubset(registry, defaultSettings(registry))).toEqual({ greeting: "short" });
  });

  test("resolves default < override < variant", () => {
    expect(resolveSettings(registry, {}, []).settings.greeting).toBe("short");
    expect(resolveSettings(registry, { greeting: "long" }, []).settings.greeting).toBe("long");
    const variant = resolveSettings(registry, { greeting: "long" }, [{ greeting: "short" }]);
    expect(variant.settings.greeting).toBe("short");
    expect(variant.invalid).toEqual([]);
  });

  test("a bad override is reported and the default stands", () => {
    const resolved = resolveSettings(registry, { serverOnly: "yes" }, []);
    expect(resolved.settings.serverOnly).toBe(false);
    expect(resolved.invalid).toEqual([{ key: "serverOnly", layer: "override" }]);
  });

  test("a bad variant value is reported and the override stands", () => {
    const resolved = resolveSettings(registry, { greeting: "long" }, [{ greeting: "nope" }]);
    expect(resolved.settings.greeting).toBe("long");
    expect(resolved.invalid).toEqual([{ key: "greeting", layer: "variant" }]);
  });
});
