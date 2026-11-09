import {
  OrchestratorMcpFailure,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- An opaque, process-bound operation fingerprint.
import * as NodeCrypto from "node:crypto";
import * as Struct from "effect/Struct";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Tool, Toolkit } from "effect/ai";

import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { withOperationPermission } from "./OperationPermissionCards.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./OrchestratorMcpService.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  readCaller,
  unavailable,
} from "./threadAccess.ts";

/**
 * Their private constructors only stop the type checker; this also stops
 * `Reflect.construct` and friends at runtime.
 */
const builtHere: unique symbol = Symbol("t3/mcp/McpToolAccess/builtHere");

const refuseOutsideConstruction = (token: symbol) => {
  if (token !== builtHere) {
    throw new TypeError("Only McpToolAccess builds MCP tool declarations and handler layers.");
  }
};

let declare: <P, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => Declaration<(params: P) => Effect.Effect<A, E, R>>;

type CheckedHandlerOf<D> = D extends Declaration<infer Handler> ? Handler : never;

interface CheckedHandler extends Struct.Lambda {
  <Handler>(declaration: Declaration<Handler>): Handler;
  readonly "~lambda.out": CheckedHandlerOf<this["~lambda.in"]>;
}
let checkedHandler: CheckedHandler;

let handlersLayer: <Tools extends Record<string, Tool.Any>, EX, RX>(
  layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
) => HandlersLayer<Tools, EX, RX>;

/**
 * Effect's own registration functions accept any handler, so the
 * `t3code/no-raw-mcp-registration` lint rule keeps Effect's `McpServer` inside
 * McpHttpServer.
 */
export class Declaration<out Handler> {
  readonly #handle: Handler;
  private constructor(token: typeof builtHere, handle: Handler) {
    refuseOutsideConstruction(token);
    this.#handle = handle;
  }
  static {
    declare = (handle) => new Declaration(builtHere, handle);
    checkedHandler = Struct.lambda<CheckedHandler>((declaration) => declaration.#handle);
  }
}

const refuseReadOnlyClient = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.client?.access === "read-only"
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This tool changes the environment, and this MCP client was approved for read-only access.",
          }),
        )
      : Effect.void,
  ),
);

const writingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(loadCaller()),
  Effect.tap(assertLiveCaller),
);

// Fingerprints bind approval to the complete arguments without storing them on a card.
// A process-local key also makes a saved request unusable after a server restart.
const fingerprintKey = NodeCrypto.randomBytes(32);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodePreview = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};
const fingerprint = (value: unknown) =>
  NodeCrypto.createHmac("sha256", fingerprintKey)
    .update(encodeJson(canonical(value)))
    .digest("hex");

const permissionUnavailable = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "This operation needs a user approval in an active auto-mode thread.",
  });

const sameCaller = (before: Caller, after: Caller) =>
  before.limits.runtimeMode === after.limits.runtimeMode &&
  before.limits.interactionMode === after.limits.interactionMode;

const redactText = (value: string) =>
  value
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[비밀값 숨김]",
    )
    .replace(/\b(Bearer\s+)\S+/gi, "$1[비밀값 숨김]")
    .replace(
      /\b((?:[\w-]*(?:token|password|secret|api[_-]?key|credential)[\w-]*)\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[비밀값 숨김]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[비밀값 숨김]@")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g,
      "[비밀값 숨김]",
    );

const safePreview = (value: unknown): unknown => {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(safePreview);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /token|password|secret|api[_-]?key|credential|authorization/i.test(key)
          ? "[비밀값 숨김]"
          : safePreview(entry),
      ]),
    );
  }
  return value;
};

export const operationSummary = (operation: string, params: unknown) => {
  const fields = params !== null && typeof params === "object" ? Object.entries(params) : [];
  const previewedFields = new Set([
    "projectId",
    "threadId",
    "sourceThreadId",
    "targetThreadId",
    "sourcePoint",
    "attachments",
    "title",
    "workspaceRoot",
    "queuedRunId",
    "runId",
    "message",
    "text",
    "questions",
    "answers",
    "scripts",
    "modelSelection",
    "defaultModelSelection",
    "defaultThreadEnvMode",
    "autoPull",
    "newWorktreesStartFromOrigin",
    "enableProviderUpdateChecks",
    "backgroundActivity",
    "sourceControlWritingStyle",
    "createWorkspaceRootIfMissing",
    "url",
    "destinationPath",
  ]);
  const descriptions = fields.map(([key, value]) => {
    // Only known operation fields are previewed, with credential values masked.
    if (previewedFields.has(key) && value !== undefined) {
      // File contents, upload URLs and screenshot accessibility data never enter the card.
      const preview =
        key === "attachments" && Array.isArray(value)
          ? value.map((attachment: unknown) =>
              attachment !== null && typeof attachment === "object"
                ? Object.fromEntries(
                    Object.entries(attachment).filter(([field]) =>
                      ["id", "type", "name", "mimeType", "sizeBytes"].includes(field),
                    ),
                  )
                : null,
            )
          : value;
      const safe = safePreview(preview);
      return `${key}: ${typeof safe === "string" ? safe : encodePreview(safe)}`;
    }
    return key;
  });
  return [operation, ...descriptions].join("\n");
};

const orchestratingCaller = refuseReadOnlyClient.pipe(
  Effect.andThen(readCaller()),
  Effect.tap(assertLiveCaller),
);

const requireThreadCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This tool")),
);

export const reads = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => handle(params));

export const readsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => requireThreadCaller.pipe(Effect.flatMap(() => handle(params))));

export const actsAsCaller = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) =>
    requireThreadCaller.pipe(
      Effect.flatMap(() => writingCaller),
      Effect.flatMap(() => handle(params)),
    ),
  );

export const writes = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => orchestratingCaller.pipe(Effect.flatMap(() => handle(params))));

/**
 * Unlike `writes` it does not need thread control; the handler checks its
 * capability, as the capability toolkits do.
 */
export const writesWithCapability = <P, A, E, R>(handle: (params: P) => Effect.Effect<A, E, R>) =>
  declare((params: P) => writingCaller.pipe(Effect.flatMap(() => handle(params))));

export const writesThreads = <P, A, E, R>(
  threads: (params: P) => ReadonlyArray<ThreadId | undefined>,
  handle: (params: P) => Effect.Effect<A, E, R>,
  operation = "thread.write",
  options?: {
    snapshot?: (params: P) => Effect.Effect<unknown, OrchestratorMcpFailure, CheckServices>;
    prepare?: (params: P) => Effect.Effect<P, OrchestratorMcpFailure, CheckServices>;
  },
) =>
  declare((input: P) =>
    Effect.gen(function* () {
      const caller = yield* writingCaller;
      const params = options?.prepare === undefined ? input : yield* options.prepare(input);
      const snapshot = options?.snapshot;
      const targets = [];
      for (const threadId of new Set(threads(params))) {
        if (threadId === undefined || threadId === caller.scope.thread?.threadId) continue;
        const target = yield* caller.threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(unavailable));
        if (target !== null && target.deletedAt === null) targets.push(target);
      }
      // A plan-mode caller never receives an execution grant.
      for (const target of targets) {
        yield* resolveInteractionMode(caller.limits.interactionMode, target.interactionMode);
      }
      const broader = targets.some(
        (target) => exceededDispatchModeLimit(caller.limits, target) !== undefined,
      );
      const canAsk =
        caller.limits.runtimeMode === "auto" &&
        caller.limits.interactionMode === "default" &&
        caller.scope.thread !== undefined;
      if (broader && !canAsk) {
        for (const target of targets) yield* assertTargetWithinLimits(caller.limits, target);
      }
      const context = broader && snapshot !== undefined ? yield* snapshot(params) : undefined;
      const contextFingerprint = fingerprint({ context });
      const approvedTargets = broader
        ? targets.map(({ id, runtimeMode, interactionMode }) => ({
            threadId: id,
            runtimeMode,
            interactionMode,
          }))
        : [];
      const execute = Effect.gen(function* () {
        const current = yield* writingCaller;
        if (!sameCaller(caller, current)) return yield* permissionUnavailable();
        for (const approved of approvedTargets) {
          const target = yield* current.threads
            .getThreadShell(approved.threadId)
            .pipe(Effect.mapError(unavailable));
          if (
            target === null ||
            target.deletedAt !== null ||
            target.runtimeMode !== approved.runtimeMode ||
            target.interactionMode !== approved.interactionMode
          ) {
            return yield* permissionUnavailable();
          }
        }
        if (
          broader &&
          snapshot !== undefined &&
          fingerprint({ context: yield* snapshot(params) }) !== contextFingerprint
        ) {
          return yield* permissionUnavailable();
        }
        // Dispatch rechecks the approved target modes under the command lock.
        const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
        return yield* handle(params).pipe(
          Effect.provideService(DispatchModeLimit, { ...caller.limits, refused, approvedTargets }),
          Effect.catch((error) =>
            Effect.flatMap(Ref.get(refused), (refusal) =>
              Effect.fail<E | OrchestratorMcpFailure>(
                refusal === undefined ? error : escalationDenied(refusal),
              ),
            ),
          ),
        );
      });
      if (!broader || caller.scope.thread === undefined) return yield* execute;
      return yield* withOperationPermission(
        { ...caller.scope, thread: caller.scope.thread },
        {
          operation,
          summary: [
            operationSummary(operation, params),
            context === undefined ? "" : encodePreview(safePreview(context)),
          ]
            .filter(Boolean)
            .join("\n"),
          reason: "대상 스레드가 현재 스레드보다 넓은 권한으로 작업을 실행할 수 있습니다.",
          targetDescription: targets
            .map(
              (target) =>
                `${target.title} (${target.id}, ${target.runtimeMode}/${target.interactionMode})`,
            )
            .join("\n"),
          fingerprint: fingerprint({
            operation,
            params,
            context,
            approvedTargets,
            caller: caller.scope.thread,
          }),
        },
        execute,
      );
    }),
  );

const escalationDenied = (refusal: DispatchModeRefusal) =>
  new OrchestratorMcpFailure({
    code:
      refusal.mode === "runtime"
        ? "runtime_mode_escalation_denied"
        : "interaction_mode_escalation_denied",
    message: `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this caller's. Its user changed it while this call ran.`,
  });

export interface StartedModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export const startsThreads = <P, A, E, R>(
  modes: (params: P) => {
    readonly runtimeMode?: RuntimeMode | undefined;
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  handle: (params: P, modes: StartedModes) => Effect.Effect<A, E, R>,
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const { limits } = yield* writingCaller;
      const requested = modes(params);
      const started: StartedModes = {
        runtimeMode: yield* resolveRuntimeMode(limits.runtimeMode, requested.runtimeMode),
        interactionMode: yield* resolveInteractionMode(
          limits.interactionMode,
          requested.interactionMode,
        ),
      };
      return yield* handle(params, started);
    }),
  );

const fullAccessRequired =
  "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.";

/**
 * `check` re-checks the caller wherever the handler waits before writing, such
 * as for a lock, since the caller's modes can change meanwhile.
 */
export const writesEnvironment = <P, A, E, R>(
  handle: (
    params: P,
    check: Effect.Effect<Caller, OrchestratorMcpFailure, CheckServices>,
  ) => Effect.Effect<A, E, R>,
  policy?: { readonly operation: string; readonly routine?: (params: P) => boolean },
) =>
  declare((params: P) =>
    Effect.gen(function* () {
      const caller = yield* orchestratingCaller;
      const full =
        caller.limits.runtimeMode === "full-access" && caller.limits.interactionMode === "default";
      const auto =
        caller.limits.runtimeMode === "auto" && caller.limits.interactionMode === "default";
      if (!full && !auto) yield* assertFullAccess(caller, fullAccessRequired);
      const check = orchestratingCaller.pipe(
        Effect.flatMap((current) =>
          sameCaller(caller, current)
            ? Effect.succeed(current)
            : Effect.fail(permissionUnavailable()),
        ),
      );
      const execute = check.pipe(Effect.flatMap(() => handle(params, check)));
      if (full || policy?.routine?.(params) === true) return yield* execute;
      if (caller.scope.thread === undefined) return yield* permissionUnavailable();
      const operation = policy?.operation ?? "environment.update";
      return yield* withOperationPermission(
        { ...caller.scope, thread: caller.scope.thread },
        {
          operation,
          summary: operationSummary(operation, params),
          reason: "프로젝트 또는 실행 환경의 민감한 설정을 변경합니다.",
          targetDescription:
            typeof params === "object" && params !== null && "projectId" in params
              ? String(params.projectId)
              : "현재 실행 환경",
          fingerprint: fingerprint({ operation, params, caller: caller.scope.thread }),
        },
        execute,
      );
    }),
  );

type CheckServices = Effect.Services<typeof orchestratingCaller>;

type Declarations<Handlers> = {
  readonly [Name in keyof Handlers]: Declaration<Handlers[Name]> & NotCallable;
};

type NotCallable = { readonly call?: never } & { readonly apply?: never };

export type Handlers<Tools extends Record<string, Tool.Any>> = Declarations<
  Toolkit.HandlersFrom<Tools>
>;

export class HandlersLayer<Tools extends Record<string, Tool.Any>, EX = never, RX = never> {
  readonly #layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>;
  private constructor(
    token: typeof builtHere,
    layer: Layer.Layer<Tool.HandlersFor<Tools>, EX, RX>,
  ) {
    refuseOutsideConstruction(token);
    this.#layer = layer;
  }
  static {
    handlersLayer = (layer) => new HandlersLayer(builtHere, layer);
  }
  static layer<Tools extends Record<string, Tool.Any>, EX, RX>(
    handlers: HandlersLayer<Tools, EX, RX>,
  ) {
    return handlers.#layer;
  }
}

const checkedHandlers = <Handlers>(declarations: Declarations<Handlers>): Handlers =>
  Struct.map(declarations, checkedHandler);

export const toLayer = <Tools extends Record<string, Tool.Any>, EX = never, RX = never>(
  toolkit: Toolkit.Toolkit<Tools>,
  build: Handlers<Tools> | Effect.Effect<Handlers<Tools>, EX, RX>,
): HandlersLayer<Tools, EX, Exclude<RX, Scope.Scope>> =>
  handlersLayer(
    toolkit.toLayer(
      Effect.isEffect(build)
        ? Effect.map(build, checkedHandlers<Toolkit.HandlersFrom<Tools>>)
        : checkedHandlers(build),
    ),
  );
