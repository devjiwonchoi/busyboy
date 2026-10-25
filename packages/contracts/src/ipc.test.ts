import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema } from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("decodes a running backend bootstrap", () => {
    expect(
      decode({
        id: "primary",
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "primary",
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows a backend that is not running to report no URLs", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).httpBaseUrl,
    ).toBeNull();
  });
});
