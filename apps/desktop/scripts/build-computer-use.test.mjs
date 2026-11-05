import { assert, describe, it } from "vite-plus/test";

import { buildComputerUse, HELPER_REQUIREMENT } from "./build-computer-use.mjs";

const base = {
  release: false,
  devCallers: false,
  identity: "Developer ID Application: Test (5PA4R2B5FF)",
  buildNumber: "1",
  timestamp: true,
};

describe("build-computer-use", () => {
  it("refuses release builds with dev callers before building anything", () => {
    assert.throws(
      () => buildComputerUse({ ...base, release: true, devCallers: true }),
      /must not enable dev-callers/,
    );
  });

  it("refuses ad-hoc signing", () => {
    assert.throws(() => buildComputerUse({ ...base, identity: "-" }), /never ad hoc/);
    assert.throws(() => buildComputerUse({ ...base, identity: "" }), /never ad hoc/);
  });

  it("pins the helper's designated requirement to the bundle id and team", () => {
    assert.equal(
      HELPER_REQUIREMENT,
      'anchor apple generic and identifier "dev.jiwon.busyboy.computer-use" and certificate leaf[subject.OU] = "5PA4R2B5FF"',
    );
  });
});
