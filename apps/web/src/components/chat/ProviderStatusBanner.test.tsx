import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderStatusBannerKey,
  getProviderStatusMessage,
  shouldShowProviderStatusBanner,
} from "./ProviderStatusBanner";

function warningProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "warning",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-23T12:00:00.000Z",
    message: "Provider is temporarily degraded.",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("ProviderStatusBanner", () => {
  it("shows installation and startup failures before auth is checked", () => {
    const status: ServerProvider = {
      ...warningProvider(),
      driver: ProviderDriverKind.make("grok"),
      auth: { status: "unknown" },
    };

    expect(shouldShowProviderStatusBanner({ ...status, installed: false }, null)).toBe(true);
    expect(shouldShowProviderStatusBanner({ ...status, status: "error" }, null)).toBe(true);
    expect(
      shouldShowProviderStatusBanner({ ...status, driver: ProviderDriverKind.make("codex") }, null),
    ).toBe(true);
  });

  it("stays hidden after its current warning is dismissed", () => {
    const status = warningProvider();

    expect(shouldShowProviderStatusBanner(status, null)).toBe(true);
    expect(shouldShowProviderStatusBanner(status, getProviderStatusBannerKey(status))).toBe(false);
  });
});

describe("getProviderStatusMessage", () => {
  it("preserves the environment's authentication error", () => {
    const message = "SUBSCRIPTION_REQUIRED: This account cannot use Grok.";
    expect(
      getProviderStatusMessage({
        ...warningProvider(),
        driver: ProviderDriverKind.make("grok"),
        status: "error",
        auth: { status: "unauthenticated" },
        message,
      }),
    ).toBe(message);
  });

  it("requires installation on the environment before sign-in", () => {
    expect(
      getProviderStatusMessage({
        ...warningProvider(),
        driver: ProviderDriverKind.make("grok"),
        displayName: "Grok work account",
        installed: false,
        status: "error",
        auth: { status: "unauthenticated" },
        setup: { canAuthenticate: false, canInstall: true },
        message: "",
      }),
    ).toBe("Open provider setup to install Grok on this environment.");
  });

  it("keeps CLI sign-in advice for a provider without integrated setup", () => {
    expect(
      getProviderStatusMessage({
        ...warningProvider(),
        status: "error",
        auth: { status: "unauthenticated" },
        message: "",
      }),
    ).toBe("Sign in via the CLI to authenticate again.");
  });
});
