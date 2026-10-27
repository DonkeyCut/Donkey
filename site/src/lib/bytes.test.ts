import { describe, expect, test } from "bun:test";

import { formatBytes } from "@/lib/bytes";
import { formatDate } from "@/cut/lib/time";

describe("sizes and moments in the reader's language", () => {
  test("a byte count keeps its units and takes the locale's digits", () => {
    expect(formatBytes(0, "en")).toBe("0 MB");
    expect(formatBytes(512, "en")).toBe("1 KB");
    expect(formatBytes(1.5 * 1024 * 1024, "en")).toBe("1.5 MB");
    expect(formatBytes(250 * 1024 * 1024, "en")).toBe("250 MB");
    expect(formatBytes(1.5 * 1024 ** 3, "en")).toBe("1.5 GB");
    expect(formatBytes(1.5 * 1024 ** 3, "de")).toBe("1,5 GB");
  });

  test("a recent moment reads relative", () => {
    const now = Date.now();
    expect(formatDate(now - 10_000, "en", "just now")).toBe("just now");
    expect(formatDate(now - 5 * 60_000, "en", "just now")).toBe("5m ago");
    expect(formatDate(now - 3 * 3_600_000, "en", "just now")).toBe("3h ago");
    expect(formatDate(now - 5 * 60_000, "de", "gerade eben")).toBe("vor 5 Min.");
    expect(formatDate(now - 3 * 3_600_000, "ja", "たった今")).toBe("3 時間前");
  });
});
