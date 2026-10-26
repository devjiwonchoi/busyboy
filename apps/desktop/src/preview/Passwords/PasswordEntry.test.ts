import { describe, expect, it } from "@effect/vitest";

import { isFillableOrigin, passwordMatchesOrigin, passwordOrigin } from "./PasswordEntry.ts";
import { choosePasswordFill } from "./PasswordVault.ts";

describe("passwordOrigin", () => {
  it("keeps only web origins", () => {
    expect(passwordOrigin(" https://accounts.example.com/signin?x=1 ")).toBe(
      "https://accounts.example.com",
    );
    expect(passwordOrigin("http://localhost:3000/login")).toBe("http://localhost:3000");
    expect(passwordOrigin("android://hash@com.example/")).toBeUndefined();
    expect(passwordOrigin("not a url")).toBeUndefined();
  });
});

describe("isFillableOrigin", () => {
  it("allows HTTPS and loopback HTTP only", () => {
    expect(isFillableOrigin("https://example.com")).toBe(true);
    expect(isFillableOrigin("http://localhost:5173")).toBe(true);
    expect(isFillableOrigin("http://example.com")).toBe(false);
    expect(isFillableOrigin("null")).toBe(false);
  });
});

describe("passwordMatchesOrigin", () => {
  const matches = (savedOrigin: string, pageOrigin: string) =>
    passwordMatchesOrigin({ savedOrigin, pageOrigin });

  it("treats www as the same site", () => {
    expect(matches("https://www.example.com", "https://example.com")).toBe(true);
  });

  it("does not match other subdomains or lookalike hosts", () => {
    expect(matches("https://example.com", "https://login.example.com")).toBe(false);
    expect(matches("https://user.github.io", "https://evil.github.io")).toBe(false);
    expect(matches("https://example.com", "https://example.com.evil.test")).toBe(false);
  });

  it("upgrades HTTP logins to HTTPS but never downgrades", () => {
    expect(matches("http://example.com", "https://example.com")).toBe(true);
    expect(matches("https://example.com", "http://example.com")).toBe(false);
  });

  it("requires the same port", () => {
    expect(matches("http://localhost:3000", "http://localhost:4000")).toBe(false);
    // Upgrading to HTTPS does not carry a dev server's login to any port.
    expect(matches("http://localhost:3000", "https://localhost:8443")).toBe(false);
    expect(matches("http://localhost:3000", "https://localhost")).toBe(false);
  });
});

describe("choosePasswordFill", () => {
  const saved = [
    {
      origin: "https://example.com",
      username: "old",
      password: "1",
      source: "chrome" as const,
      savedAt: 1,
    },
    {
      origin: "https://example.com",
      username: "new",
      password: "2",
      source: "1password" as const,
      savedAt: 2,
    },
    {
      origin: "https://other.test",
      username: "x",
      password: "3",
      source: "chrome" as const,
      savedAt: 3,
    },
  ];

  it("prefers the username already on the page", () => {
    expect(
      choosePasswordFill({ saved, pageOrigin: "https://example.com", typedUsername: "old" })
        ?.password,
    ).toBe("1");
  });

  it("otherwise picks the most recently saved login for the origin", () => {
    expect(
      choosePasswordFill({ saved, pageOrigin: "https://example.com", typedUsername: "" })?.password,
    ).toBe("2");
  });

  it("returns nothing for a site without a saved login", () => {
    expect(
      choosePasswordFill({ saved, pageOrigin: "https://nope.test", typedUsername: "" }),
    ).toBeUndefined();
  });
});
