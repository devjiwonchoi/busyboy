import { assert, describe, it } from "@effect/vitest";

import { computerUseAppPolicy } from "./ComputerUsePolicy.ts";

describe("computerUseAppPolicy", () => {
  it("allows ordinary apps", () => {
    assert.deepStrictEqual(computerUseAppPolicy("com.apple.TextEdit"), { kind: "allowed" });
  });

  it("forbids Busyboy, including its dev builds, whatever the case", () => {
    for (const bundleId of ["dev.jiwon.busyboy", "DEV.JIWON.BUSYBOY", "dev.jiwon.busyboy.dev.wt"]) {
      const policy = computerUseAppPolicy(bundleId);
      assert.strictEqual(policy.kind, "forbidden");
      assert.include(policy.kind === "forbidden" ? policy.reason : "", "Busyboy");
    }
  });

  it("forbids credential stores and terminals", () => {
    for (const bundleId of [
      "com.apple.keychainaccess",
      "com.1password.1password",
      "com.apple.Terminal",
      "com.googlecode.iterm2",
      "com.mitchellh.ghostty",
    ]) {
      assert.strictEqual(computerUseAppPolicy(bundleId).kind, "forbidden", bundleId);
    }
  });

  it("does not treat a lookalike prefix as Busyboy", () => {
    assert.deepStrictEqual(computerUseAppPolicy("dev.jiwon.busyboyish"), { kind: "allowed" });
  });

  it("refuses apps without a bundle ID", () => {
    assert.deepStrictEqual(computerUseAppPolicy(undefined), { kind: "unidentified" });
    assert.deepStrictEqual(computerUseAppPolicy("  "), { kind: "unidentified" });
  });
});
