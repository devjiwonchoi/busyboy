// @effect-diagnostics nodeBuiltinImport:off - Request identities must not replay across server restarts.
import {
  CommandId,
  OperationPermissionError,
  OrchestratorMcpFailure,
  TurnItemId,
  type OperationPermissionAnswerInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export type OperationPermissionRequest = {
  readonly operation: string;
  readonly summary: string;
  readonly reason: string;
  readonly targetDescription: string;
  readonly fingerprint: string;
};

type PermissionStatus =
  | "pending"
  | "approved"
  | "declined"
  | "cancelled"
  | "expired"
  | "consumed"
  | "succeeded"
  | "failed";

export const OPERATION_PERMISSION_TTL_MS = 5 * 60 * 1_000;
const POLL_INTERVAL_MS = 500;
const encodeFingerprint = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

/** Only the authenticated app RPC can answer. No MCP or AFK path exposes this service's answer. */
export class OperationPermissions extends Context.Service<
  OperationPermissions,
  {
    readonly answer: (
      input: OperationPermissionAnswerInput,
    ) => Effect.Effect<void, OperationPermissionError>;
    readonly withPermission: <A, E, R>(
      scope: McpThreadInvocationScope,
      input: OperationPermissionRequest,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OrchestratorMcpFailure, R>;
  }
>()("t3/permissions/OperationPermissions") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const lock = yield* Semaphore.make(1);
  const pending = new Map<
    string,
    {
      readonly threadId: string;
      readonly assertLive: Effect.Effect<void, OperationPermissionError>;
      readonly record: (status: PermissionStatus) => Effect.Effect<void, OperationPermissionError>;
      readonly expiresAt: number;
      status: PermissionStatus;
    }
  >();

  const answer: OperationPermissions["Service"]["answer"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const request = pending.get(input.turnItemId);
        if (request === undefined || request.threadId !== input.threadId) {
          return yield* new OperationPermissionError({ reason: "not_found" });
        }
        if (request.status !== "pending") {
          return yield* new OperationPermissionError({ reason: "already_answered" });
        }
        if ((yield* Clock.currentTimeMillis) >= request.expiresAt) {
          yield* request.record("expired");
          request.status = "expired";
          return yield* new OperationPermissionError({ reason: "expired" });
        }
        yield* request.assertLive;
        const status = input.decision === "allow" ? "approved" : "declined";
        yield* request.record(status);
        request.status = status;
      }).pipe(Effect.uninterruptible),
    );

  const withPermission: OperationPermissions["Service"]["withPermission"] = (
    scope,
    input,
    effect,
  ) =>
    Effect.gen(function* () {
      const records = yield* threads
        .getThreadRecords(scope.thread.threadId, ["runs", "providerThreads"], {
          turnItemTypes: [],
          messageRoles: [],
        })
        .pipe(Effect.mapError(() => failure("승인 요청을 위한 실행 정보를 읽지 못했습니다.")));
      const run = ThreadManagement.latestActiveRun(records);
      const providerThread = records.providerThreads.find(
        (thread) => thread.id === run?.providerThreadId,
      );
      if (
        records.thread.archivedAt !== null ||
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== scope.thread.providerInstanceId ||
        providerThread?.providerSessionId !== scope.thread.providerSessionId
      ) {
        return yield* failure("현재 실행을 소유한 활성 스레드에서만 승인을 요청할 수 있습니다.");
      }
      const runId = run.id;
      const nodeId = run.rootNodeId;
      const turnItemId = TurnItemId.make(`operation-permission:${NodeCrypto.randomUUID()}`);
      const expiresAt = (yield* Clock.currentTimeMillis) + OPERATION_PERMISSION_TTL_MS;
      // Only a digest, a safe description and the outcome enter the durable transcript.
      const request = {
        ...input,
        fingerprint: NodeCrypto.createHash("sha256")
          .update(
            encodeFingerprint([
              scope.thread.threadId,
              runId,
              scope.thread.providerInstanceId,
              scope.thread.providerSessionId,
              input.operation,
              input.fingerprint,
            ]),
          )
          .digest("hex"),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
      };
      const record = (permissionStatus: PermissionStatus) =>
        threads
          .dispatch({
            type: "operation_permission.record",
            commandId: CommandId.make(`${turnItemId}:${permissionStatus}`),
            threadId: scope.thread.threadId,
            runId,
            nodeId,
            turnItemId,
            ...request,
            permissionStatus,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              (cause) => new OperationPermissionError({ reason: "record_failed", cause }),
            ),
          );
      const assertLive = threads
        .getThreadRecords(scope.thread.threadId, ["runs", "providerThreads"], {
          turnItemTypes: [],
          messageRoles: [],
        })
        .pipe(
          Effect.mapError(
            (cause) => new OperationPermissionError({ reason: "load_failed", cause }),
          ),
          Effect.flatMap((current) => {
            const active = ThreadManagement.latestActiveRun(current);
            const provider = current.providerThreads.find(
              (thread) => thread.id === active?.providerThreadId,
            );
            return current.thread.archivedAt === null &&
              active?.id === runId &&
              active.providerInstanceId === scope.thread.providerInstanceId &&
              provider?.providerSessionId === scope.thread.providerSessionId
              ? Effect.void
              : Effect.fail(new OperationPermissionError({ reason: "agent_stopped" }));
          }),
        );
      const entry = {
        threadId: scope.thread.threadId,
        assertLive,
        record,
        expiresAt,
        status: "pending" as PermissionStatus,
      };
      pending.set(turnItemId, entry);

      const wait = Effect.gen(function* () {
        yield* record("pending");
        while (entry.status === "pending") {
          if ((yield* Clock.currentTimeMillis) >= expiresAt) {
            yield* lock.withPermit(
              Effect.gen(function* () {
                if (entry.status === "pending") {
                  yield* record("expired");
                  entry.status = "expired";
                }
              }).pipe(Effect.uninterruptible),
            );
            break;
          }
          yield* assertLive;
          yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
        }
        yield* lock.withPermit(
          Effect.gen(function* () {
            if (entry.status !== "approved") {
              return yield* new OperationPermissionError({ reason: entry.status });
            }
            if ((yield* Clock.currentTimeMillis) >= expiresAt) {
              yield* record("expired");
              entry.status = "expired";
              return yield* new OperationPermissionError({ reason: "expired" });
            }
            yield* assertLive;
            yield* record("consumed");
            entry.status = "consumed";
          }).pipe(Effect.uninterruptible),
        );
      }).pipe(
        Effect.mapError(() =>
          failure("이 작업에 대한 사용자 승인이 없거나 더 이상 유효하지 않습니다."),
        ),
      );

      return yield* wait.pipe(
        Effect.andThen(effect),
        Effect.onExit((exit) =>
          lock.withPermit(
            Effect.gen(function* () {
              pending.delete(turnItemId);
              const status =
                entry.status === "consumed"
                  ? Exit.isSuccess(exit)
                    ? "succeeded"
                    : "failed"
                  : entry.status === "pending" || entry.status === "approved"
                    ? "cancelled"
                    : undefined;
              if (status !== undefined) {
                yield* record(status).pipe(
                  Effect.mapError(() =>
                    failure("작업 결과의 승인 감사 기록을 저장하지 못했습니다."),
                  ),
                );
              }
            }),
          ),
        ),
      );
    });

  return OperationPermissions.of({ answer, withPermission });
});

export const layer = Layer.effect(OperationPermissions, make);
