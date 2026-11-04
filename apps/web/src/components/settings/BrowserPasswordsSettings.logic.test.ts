import { describe, expect, it } from "vite-plus/test";

import {
  formatLastUsed,
  loginSite,
  passwordsUnavailableMessage,
} from "./BrowserPasswordsSettings.logic";

describe("BrowserPasswordsSettings.logic", () => {
  it("shows the host and port of a login origin", () => {
    expect(loginSite("https://accounts.example.com")).toBe("accounts.example.com");
    expect(loginSite("http://localhost:3000")).toBe("localhost:3000");
    expect(loginSite("not a url")).toBe("not a url");
  });

  it("formats last used, with Never for logins that were never used", () => {
    const now = Date.UTC(2026, 10, 4, 12);
    expect(formatLastUsed(null, now)).toBe("Never");
    expect(formatLastUsed(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(formatLastUsed(now - 3 * 86_400_000, now)).toBe("3d ago");
  });

  it("explains each unavailable reason", () => {
    expect(passwordsUnavailableMessage("encryptionUnavailable")).toMatch(
      /secure storage isn't available/,
    );
    expect(passwordsUnavailableMessage(undefined)).toBe(
      passwordsUnavailableMessage("databaseUnavailable"),
    );
  });
});
