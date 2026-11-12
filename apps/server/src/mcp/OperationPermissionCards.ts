import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  OperationPermissions,
  type OperationPermissionRequest,
} from "../permissions/OperationPermissions.ts";
import type { McpThreadInvocationScope } from "./McpInvocationContext.ts";

/** The supplied effect rechecks the operation's caller and exact targets before writing. */
export const withOperationPermission = <A, E, R>(
  scope: McpThreadInvocationScope,
  input: OperationPermissionRequest,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.serviceOption(OperationPermissions).pipe(
    Effect.flatMap((permissions) =>
      Option.isSome(permissions)
        ? permissions.value.withPermission(scope, input, effect)
        : Effect.fail(
            new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "이 환경에서는 사용자 실행 승인을 요청할 수 없습니다.",
            }),
          ),
    ),
  );
