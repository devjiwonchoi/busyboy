import { describe, expect, it } from "vite-plus/test";

import { truncate } from "./String.ts";

describe("truncate", () => {
  it("returns trimmed text that fits within the limit", () => {
    expect(truncate("  hello  ", 5)).toBe("hello");
  });

  it("cuts longer text and appends an ellipsis", () => {
    expect(truncate("hello world", 5)).toBe("hello...");
  });

  it("defaults the limit to 50 characters", () => {
    expect(truncate("a".repeat(50))).toBe("a".repeat(50));
    expect(truncate("a".repeat(51))).toBe(`${"a".repeat(50)}...`);
  });
});
