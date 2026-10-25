import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AuthEnvironmentScopes, sessionGrantsScope } from "./auth.ts";

describe("authorization grants", () => {
  it("rejects scopes the environment does not define", () => {
    expect(() => Schema.decodeUnknownSync(AuthEnvironmentScopes)(["review:write"])).toThrow();
  });

  it.each([
    {
      label: "the exact scope",
      session: { authenticated: true, scopes: ["settings:write"] },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "no broader scope in place of a granular one",
      session: { authenticated: true, scopes: ["orchestration:operate"] },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "nothing for an unauthenticated session",
      session: { authenticated: false, scopes: ["settings:write"] },
      scope: "settings:write",
      expected: false,
    },
  ] as const)("sessionGrantsScope accepts $label", ({ session, scope, expected }) => {
    expect(sessionGrantsScope(session, scope)).toBe(expected);
  });
});
