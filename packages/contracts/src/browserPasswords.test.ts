import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  BrowserPasswordFillChooseInput,
  BrowserPasswordPromptInput,
  BrowserPasswordPromptResponse,
  BrowserPasswordTabInput,
} from "./browserPasswords.ts";

// The shape the desktop app gives a browser tab: [environment, thread, project, tab].
const RUNTIME_TAB_ID = JSON.stringify([
  "d389aa07-d964-4cc0-98ae-ee9439964332",
  "0924936c-a45d-47dd-9e48-bcda41bc2c86",
  "aa2b2950-0467-4cfd-b8b5-f9cef0541448",
  "tab_1_aa2b2950-0467-4cfd-b8b5-f9cef0541448",
]);

describe("browser password autofill inputs", () => {
  it("accept a real runtime tab id", () => {
    expect(RUNTIME_TAB_ID.length).toBeGreaterThan(128);
    const decodes = [
      Schema.decodeUnknownSync(BrowserPasswordFillChooseInput)({
        tabId: RUNTIME_TAB_ID,
        requestId: "req-1",
        loginId: 1,
      }),
      Schema.decodeUnknownSync(BrowserPasswordTabInput)({ tabId: RUNTIME_TAB_ID }),
      Schema.decodeUnknownSync(BrowserPasswordPromptInput)({
        tabId: RUNTIME_TAB_ID,
        promptId: "p-1",
      }),
      Schema.decodeUnknownSync(BrowserPasswordPromptResponse)({
        tabId: RUNTIME_TAB_ID,
        promptId: "p-1",
        action: "save",
        username: "alice",
      }),
    ];
    for (const decoded of decodes) expect(decoded.tabId).toBe(RUNTIME_TAB_ID);
  });

  it("still bound the tab id", () => {
    expect(() =>
      Schema.decodeUnknownSync(BrowserPasswordTabInput)({ tabId: "x".repeat(1025) }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(BrowserPasswordTabInput)({ tabId: "" })).toThrow();
  });
});
