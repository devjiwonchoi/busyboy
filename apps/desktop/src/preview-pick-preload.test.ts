// @effect-diagnostics nodeBuiltinImport:off - Reads the preload's source files to check its imports.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { isBundledIntoPreviewPreload } from "./preview/previewPreloadBundle.ts";

const RUNTIME_IMPORT =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/gm;

/** Every module specifier the preload loads at runtime, following relative imports. */
function runtimeImports(entry: string): Map<string, string> {
  const bare = new Map<string, string>();
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = NodeFs.readFileSync(file, "utf8");
    for (const match of source.matchAll(RUNTIME_IMPORT)) {
      const specifier = match[1] ?? match[2]!;
      if (specifier.startsWith(".")) visit(NodePath.resolve(NodePath.dirname(file), specifier));
      else if (!bare.has(specifier)) bare.set(specifier, NodePath.relative(__dirname, file));
    }
  };
  visit(NodePath.join(__dirname, entry));
  return bare;
}

describe("browser guest preload", () => {
  it("only loads electron or packages the build bundles into it", () => {
    const imports = runtimeImports("preview-pick-preload.ts");
    expect(imports.has("electron")).toBe(true);
    const unresolvable = [...imports]
      .filter(([specifier]) => specifier !== "electron" && !isBundledIntoPreviewPreload(specifier))
      .map(([specifier, file]) => `${specifier} (from ${file})`);
    expect(unresolvable).toEqual([]);
  });
});
