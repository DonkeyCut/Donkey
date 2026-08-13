import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Raw `<Slider` budget per file. ValueSlider is the one way a settings row
 * exposes a numeric value — slider plus editable readout, width pinned while
 * editing — so a new row gets manual entry and a stable layout by using it.
 * The timeline's two zoom sliders are view controls and keep the raw slider.
 */
const ALLOWED: Record<string, number> = {
  // The wrapper's own render plus its doc comment quoting the banned string.
  "ValueSlider.tsx": 2,
  "Timeline.tsx": 2,
};

describe("ValueSlider", () => {
  test("every settings slider renders through ValueSlider", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      if (!rel.endsWith(".tsx")) continue;
      const base = rel.split("/").pop()!;
      const uses = (readFileSync(join(root, rel), "utf8").match(/<Slider\b/g) ?? []).length;
      if (uses > (ALLOWED[base] ?? 0)) offenders.push(`${rel} (${uses})`);
    }
    expect(offenders).toEqual([]);
  });
});
