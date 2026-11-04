// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { recordingKeyLabel, recordingKeysAreSensitive } from "./RecordingInput.ts";

const key = (
  value: string,
  modifiers: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  key: value,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe("recording key labels", () => {
  it("formats macOS and other-platform shortcuts", () => {
    expect(recordingKeyLabel(key("c", { metaKey: true }), true)).toBe("⌘C");
    expect(recordingKeyLabel(key("c", { ctrlKey: true }), false)).toBe("Ctrl + C");
    expect(recordingKeyLabel(key("Tab", { altKey: true, shiftKey: true }), true)).toBe("⌥⇧⇥");
  });
  it("shows held modifiers once and labels navigation keys", () => {
    expect(recordingKeyLabel(key("Meta", { metaKey: true }), true)).toBe("⌘");
    expect(recordingKeyLabel(key("Shift", { shiftKey: true }), false)).toBe("Shift");
    expect(recordingKeyLabel(key("ArrowLeft"), true)).toBe("←");
    expect(recordingKeyLabel(key(" "), false)).toBe("Space");
  });
  it.each(["Dead", "Unidentified", "Process", ""])("excludes composition key %s", (value) => {
    expect(recordingKeyLabel(key(value), true)).toBeNull();
  });
});

describe("recording key privacy", () => {
  const sensitive = (html: string, focusSelector: string) => {
    document.body.innerHTML = html;
    (document.querySelector(focusSelector) as HTMLElement).focus();
    return recordingKeysAreSensitive(document);
  };
  it("masks keys typed into sign-in and contact fields", () => {
    expect(sensitive(`<input type="password">`, "input")).toBe(true);
    expect(sensitive(`<input type="email">`, "input")).toBe(true);
    expect(sensitive(`<input type="tel">`, "input")).toBe(true);
    expect(sensitive(`<input autocomplete="username">`, "input")).toBe(true);
    expect(sensitive(`<input autocomplete="one-time-code">`, "input")).toBe(true);
    expect(sensitive(`<label>Verification code <input></label>`, "input")).toBe(true);
    expect(sensitive(`<input name="phoneNumber">`, "input")).toBe(true);
  });
  it("shows keys typed into ordinary fields", () => {
    expect(sensitive(`<input type="search" name="q">`, "input")).toBe(false);
    expect(sensitive(`<textarea aria-label="Message"></textarea>`, "textarea")).toBe(false);
  });
  it("masks focus it cannot inspect", () => {
    const fake = (activeElement: unknown) =>
      recordingKeysAreSensitive({ activeElement } as Document);
    expect(fake({ tagName: "IFRAME", getAttribute: () => null })).toBe(true);
    expect(fake({ tagName: "SECRET-FIELD", getAttribute: () => null })).toBe(true);
  });
});
