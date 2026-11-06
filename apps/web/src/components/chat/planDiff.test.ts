import { describe, expect, it } from "vite-plus/test";

import { diffWords } from "./planDiff";

describe("diffWords", () => {
  it("returns one same part for equal text", () => {
    expect(diffWords("Keep the scroll", "Keep the scroll")).toEqual([
      { kind: "same", text: "Keep the scroll" },
    ]);
  });

  it("marks replaced words as a deletion then an insertion", () => {
    expect(diffWords("Keep the scroll position", "Keep the cursor position")).toEqual([
      { kind: "same", text: "Keep the " },
      { kind: "delete", text: "scroll" },
      { kind: "insert", text: "cursor" },
      { kind: "same", text: " position" },
    ]);
  });

  it("handles added and removed text at the ends", () => {
    expect(diffWords("", "New plan")).toEqual([{ kind: "insert", text: "New plan" }]);
    expect(diffWords("Old plan", "")).toEqual([{ kind: "delete", text: "Old plan" }]);
    expect(diffWords("Ship it", "Ship it today")).toEqual([
      { kind: "same", text: "Ship it" },
      { kind: "insert", text: " today" },
    ]);
  });

  it("rebuilds both texts from the parts", () => {
    const before = "Move the redirect into the guard.\nAdd a test.";
    const after = "Move the redirect into the auth guard.\nAdd a regression test.";
    const parts = diffWords(before, after);
    const join = (skip: string) =>
      parts
        .filter((part) => part.kind !== skip)
        .map((part) => part.text)
        .join("");
    expect(join("insert")).toBe(before);
    expect(join("delete")).toBe(after);
  });
});
