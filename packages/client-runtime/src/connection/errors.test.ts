import { EnvironmentAuthInvalidError } from "@busyboy/contracts";
import { describe, expect, it } from "@effect/vitest";

import { mapRemoteEnvironmentError } from "./errors.ts";
import { RemoteEnvironmentAuthFetchError, RemoteEnvironmentAuthTimeoutError } from "../rpc/http.ts";

describe("mapRemoteEnvironmentError", () => {
  it("blocks on a rejected credential", () => {
    const mapped = mapRemoteEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "trace-1",
      }),
    );
    expect(mapped).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
      detail: "The environment credential is invalid.",
      traceId: "trace-1",
    });
  });

  it.each([
    new RemoteEnvironmentAuthFetchError({
      message: "Failed to fetch remote environment endpoint.",
      cause: new TypeError("Failed to fetch"),
    }),
    new RemoteEnvironmentAuthTimeoutError("https://environment.example.test", 10_000),
  ])("retries when the environment cannot be reached: $_tag", (error) => {
    expect(mapRemoteEnvironmentError(error)).toMatchObject({
      _tag: "ConnectionTransientError",
      detail: error.message,
    });
  });
});
