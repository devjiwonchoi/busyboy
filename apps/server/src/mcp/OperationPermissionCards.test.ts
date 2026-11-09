import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { withOperationPermission } from "./OperationPermissionCards.ts";

describe("withOperationPermission", () => {
  it.effect("fails closed when execution approval is not installed", () =>
    Effect.gen(function* () {
      let writes = 0;
      const exit = yield* withOperationPermission(
        {
          environmentId: EnvironmentId.make("environment"),
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
          requestNamespace: "test",
          thread: {
            threadId: ThreadId.make("thread"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: "session",
          },
          client: undefined,
        },
        {
          operation: "send",
          summary: "메시지 전송",
          reason: "더 넓은 권한의 대상입니다.",
          targetDescription: "대상",
          fingerprint: "operation-digest",
        },
        Effect.sync(() => {
          writes += 1;
        }),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(writes, 0);
    }),
  );
});
