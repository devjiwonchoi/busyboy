import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_KEYBINDINGS } from "./keybindings.ts";

describe("DEFAULT_KEYBINDINGS", () => {
  it("never binds the same key twice under the same when clause", () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const binding of DEFAULT_KEYBINDINGS) {
      const slot = `${binding.key}|${binding.when ?? ""}`;
      const previous = seen.get(slot);
      if (previous !== undefined) duplicates.push(`${slot}: ${previous} and ${binding.command}`);
      seen.set(slot, binding.command);
    }
    expect(duplicates).toEqual([]);
  });

  it("opens the one chat side chat with mod+shift+s", () => {
    const bindings = DEFAULT_KEYBINDINGS.filter((binding) => binding.key === "mod+shift+s");
    expect(bindings.map((binding) => binding.command)).toEqual(["oneChat.sideChat.toggle"]);
  });

  it("never shares a key between an unscoped binding and any other binding", () => {
    const overlaps: string[] = [];
    for (const binding of DEFAULT_KEYBINDINGS) {
      if (binding.when !== undefined) continue;
      for (const other of DEFAULT_KEYBINDINGS) {
        if (other !== binding && other.key === binding.key) {
          overlaps.push(`${binding.key}: ${binding.command} and ${other.command}`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });
});
