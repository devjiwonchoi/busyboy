import { describe, expect, it } from "@effect/vitest";

import { defaultPersonaEmoji, defaultPersonaName, VOICE_PRESETS, voiceText } from "./persona.ts";

describe("persona defaults", () => {
  it("gives the same project the same name and emoji every time", () => {
    expect(defaultPersonaName("project-a")).toBe(defaultPersonaName("project-a"));
    expect(defaultPersonaEmoji("project-a")).toBe(defaultPersonaEmoji("project-a"));
  });

  it("spreads projects across different names", () => {
    const names = new Set(
      Array.from({ length: 30 }, (_, index) => defaultPersonaName(`p-${index}`)),
    );
    expect(names.size).toBeGreaterThan(5);
  });

  it("uses custom voice text and falls back to chill when it is empty", () => {
    expect(voiceText("custom", "  talk like a pirate ")).toBe("talk like a pirate");
    expect(voiceText("custom", "   ")).toBe(VOICE_PRESETS.chill);
    expect(voiceText("dry")).toBe(VOICE_PRESETS.dry);
  });
});
