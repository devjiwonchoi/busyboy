import { describe, expect, it } from "vite-plus/test";

import { deriveTaskTitle } from "./quickTask.logic";

describe("deriveTaskTitle", () => {
  it("uses the first non-empty line without markdown markers", () => {
    expect(deriveTaskTitle("\n\n## Fix the login redirect\nmore context")).toBe(
      "Fix the login redirect",
    );
    expect(deriveTaskTitle("- broken sidebar")).toBe("broken sidebar");
  });

  it("cuts long lines at a word boundary", () => {
    const title = deriveTaskTitle(`${"word ".repeat(40)}end`);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("word…")).toBe(true);
  });

  it("is empty when there is no text", () => {
    expect(deriveTaskTitle("  \n ")).toBe("");
  });
});
