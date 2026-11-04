import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingArtifact,
  type ToolActivityIcon,
  type ThreadId,
  type PreviewAutomationOperation,
  type PreviewAutomationOpenInput,
  type PreviewAutomationRecordingStatus,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSelectResult,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewAutomationSignInInput,
  type PreviewAutomationHistoryInput,
  OrchestratorMcpFailure,
  DEFAULT_BROWSER_AGENT_HISTORY_ACCESS,
  type PreviewTabId,
} from "@t3tools/contracts";

import {
  parseAttachmentUuid,
  parseAttachmentFileExtension,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  toSafeThreadAttachmentSegment,
} from "../../../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../../../attachmentPaths.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { requestBrowserAction } from "../../BrowserRequestCards.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

/** Whether a preview the agent
 * said nothing about surfaces is the user's `browserAutoShowFloatingPreview`
 * preference, which is desktop-local and unreadable from here — filling in
 * `true` would silently override it for every `preview_open`.
 */
export function normalizePreviewOpenInput(
  input: PreviewAutomationOpenInput,
): PreviewAutomationOpenInput {
  const open = input.open ?? input.show;
  return {
    ...input,
    ...(open === undefined ? {} : { open, show: open }),
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  { result: A; toolIcon?: ToolActivityIcon },
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  let targetTabId = tabId;
  const result = yield* broker.invoke<A>({
    onTargetTab: (resolvedTabId) => {
      targetTabId = resolvedTabId;
    },
    scope,
    operation,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  });
  if (["status", "open", "navigate", "snapshot"].includes(operation)) return { result };
  const statusTabId =
    (operation !== "evaluate" && typeof result === "object" && result !== null
      ? (result as { tabId?: PreviewTabId }).tabId
      : undefined) ?? targetTabId;
  const page = yield* broker
    .invoke<PreviewAutomationStatus>({
      scope,
      operation: "status",
      input: {},
      timeoutMs: 500,
      updateCurrentTab: false,
      ...(statusTabId === undefined ? {} : { tabId: statusTabId }),
    })
    .pipe(Effect.orElseSucceed(() => null));
  return {
    result,
    ...(page?.url && /^https?:\/\//i.test(page.url) && page.url.length <= 4096
      ? { toolIcon: { _tag: "website" as const, pageUrl: page.url } }
      : {}),
  };
});

const invokeTargeted = <A extends object>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId).pipe(
    Effect.map(({ result, toolIcon }) => ({
      ...result,
      ...(toolIcon ? { toolIcon } : {}),
    })),
  );
};

const UploadedRecordingArtifact = Schema.Struct({
  ...PreviewAutomationRecordingArtifact.fields,
  uploadedAttachmentId: Schema.optional(Schema.String),
});
const decodeUploadedRecordingArtifact = Schema.decodeUnknownEffect(UploadedRecordingArtifact);

export const claimPreviewRecording = Effect.fn("PreviewToolkit.claimRecording")(function* (
  threadId: ThreadId,
  response: unknown,
) {
  const artifact = yield* decodeUploadedRecordingArtifact(response).pipe(
    Effect.mapError(
      (cause) =>
        new PreviewAutomationRecordingTransferError({
          threadId,
          cause,
        }),
    ),
  );
  if (!artifact.uploadedAttachmentId) {
    return yield* new PreviewAutomationRecordingDesktopUpdateRequiredError({ threadId });
  }
  const config = yield* ServerConfig.ServerConfig;
  const uuid = parseAttachmentUuid(artifact.uploadedAttachmentId);
  const extension = parseAttachmentFileExtension(artifact.uploadedAttachmentId);
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}-${extension}`;
  if (!uuid || !extension || !threadSegment || artifact.uploadedAttachmentId !== pendingId) {
    return yield* new PreviewAutomationRecordingTransferError({
      threadId,
    });
  }
  const finalId = `${threadSegment}-${uuid}-${extension}`;
  const currentPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${pendingId}.${extension}`,
  });
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${finalId}.${extension}`,
  });
  if (!currentPath || !finalPath) {
    return yield* new PreviewAutomationRecordingTransferError({ threadId });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const validateFile = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.filterOrFail(
        (stat) =>
          stat.type === "File" &&
          Number(stat.size) === artifact.sizeBytes &&
          artifact.sizeBytes > 0 &&
          artifact.sizeBytes <= PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        () => new PreviewAutomationRecordingTransferError({ threadId }),
      ),
    );
  yield* Effect.gen(function* () {
    yield* validateFile(currentPath);
    yield* fileSystem.rename(currentPath, finalPath);
  }).pipe(
    Effect.catchIf(
      (cause) =>
        cause._tag !== "PreviewAutomationRecordingTransferError" &&
        cause.reason._tag === "NotFound",
      () => validateFile(finalPath),
    ),
    Effect.mapError((cause) => new PreviewAutomationRecordingTransferError({ threadId, cause })),
  );
  const { uploadedAttachmentId: _uploadedAttachmentId, ...recording } = artifact;
  return { ...recording, id: finalId, path: finalPath };
});

/** Origins of the page's frames, read in the page so agents can sign in to an embedded login. */
const FRAME_ORIGINS_EXPRESSION = `[...document.querySelectorAll("iframe[src]")].flatMap((frame) => { try { return [new URL(frame.src, location.href).origin]; } catch { return []; } })`;

export function normalizeSignInOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

const DEFAULT_HISTORY_LIMIT = 20;
/** With "allow" there is no card to answer; don't wait long for a desktop app that isn't there. */
const AUTO_APPROVED_HISTORY_TIMEOUT_MS = 30_000;

export const signIn = Effect.fn("PreviewToolkit.signIn")(function* (
  input: PreviewAutomationSignInInput,
) {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const target = normalizeSignInOrigin(input.origin);
  if (target === null) return { status: "origin_mismatch" as const };
  const { result: status } = yield* invoke<PreviewAutomationStatus>(
    "status",
    input.tabId === undefined ? {} : { tabId: input.tabId },
    undefined,
    input.tabId,
  );
  if (status.tabId === null || status.url === null) return { status: "unavailable" as const };
  if (normalizeSignInOrigin(status.url) !== target) {
    const { result: frames } = yield* invoke<unknown>(
      "evaluate",
      { expression: FRAME_ORIGINS_EXPRESSION },
      undefined,
      status.tabId,
    );
    if (!Array.isArray(frames) || !frames.includes(target)) {
      return { status: "origin_mismatch" as const };
    }
  }
  const answer = yield* requestBrowserAction(scope, {
    kind: "sign_in",
    origin: target,
    tabId: status.tabId,
    reason: input.reason ?? "",
    timeoutMs: input.timeoutMs,
    clientRequestId: input.clientRequestId,
  });
  switch (answer.status) {
    case "submitted":
    case "submitted_unconfirmed":
    case "filled":
    case "declined":
    case "page_left_origin":
    case "no_login_form":
    case "unavailable":
    case "timed_out":
      return { status: answer.status };
    // A withdrawn card (the turn was interrupted) reads as declined.
    case "cancelled":
    case "pending":
    case "allowed":
      return { status: "declined" as const };
  }
});

export const history = Effect.fn("PreviewToolkit.history")(function* (
  input: PreviewAutomationHistoryInput,
) {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  // Hosts without server settings (narrow test hosts) use the default: ask.
  const settingsService = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const mode = Option.isSome(settingsService)
    ? (yield* settingsService.value.getSettings.pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Unable to read server settings.",
            }),
        ),
      )).browserAgentHistoryAccess
    : DEFAULT_BROWSER_AGENT_HISTORY_ACCESS;
  if (mode === "off") return { status: "history_access_disabled" as const };
  const autoApprove = mode === "allow";
  const answer = yield* requestBrowserAction(scope, {
    kind: "history",
    reason: input.reason ?? "",
    tabId: input.tabId,
    query: input.query,
    since: input.since,
    limit: input.limit ?? DEFAULT_HISTORY_LIMIT,
    autoApprove,
    timeoutMs: input.timeoutMs ?? (autoApprove ? AUTO_APPROVED_HISTORY_TIMEOUT_MS : undefined),
    clientRequestId: input.clientRequestId,
  });
  switch (answer.status) {
    case "allowed":
      return { status: "allowed" as const, visits: answer.visits ?? [] };
    case "timed_out":
      return { status: autoApprove ? ("unavailable" as const) : ("timed_out" as const) };
    case "unavailable":
      return { status: "unavailable" as const };
    default:
      return { status: "declined" as const };
  }
});

const handlers = {
  preview_dialog: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("dialog", input),
  ),
  preview_status: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("status", input ?? {}),
  ),
  preview_open: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("open", normalizePreviewOpenInput(input)),
  ),
  preview_navigate: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  ),
  preview_resize: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  ),
  preview_set_appearance: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  ),
  preview_snapshot: McpToolAccess.readsAsCaller((input) => {
    const { includeImage: _includeImage, save: _save, ...operationInput } = input ?? {};
    return invokeTargeted<PreviewAutomationSnapshot>("snapshot", operationInput);
  }),
  preview_click: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<object>("click", input, input.timeoutMs),
  ),
  preview_type: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<object>("type", input, input.timeoutMs),
  ),
  preview_hover: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<object>("hover", input, input.timeoutMs),
  ),
  preview_select: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationSelectResult>("select", input, input.timeoutMs),
  ),
  preview_drag: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<object>("drag", input, input.timeoutMs),
  ),
  preview_upload: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<object>("upload", input, input.timeoutMs),
  ),
  preview_press: McpToolAccess.actsAsCaller((input) => invokeTargeted<object>("press", input)),
  preview_scroll: McpToolAccess.actsAsCaller((input) => invokeTargeted<object>("scroll", input)),
  preview_evaluate: McpToolAccess.actsAsCaller(({ tabId, ...input }) =>
    invoke<unknown>("evaluate", input, undefined, tabId).pipe(
      Effect.map(({ result, toolIcon }) => ({
        value: result ?? null,
        ...(toolIcon ? { toolIcon } : {}),
      })),
    ),
  ),
  preview_wait_for: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<object>("waitFor", input, input.timeoutMs),
  ),
  preview_sign_in: McpToolAccess.actsAsCaller((input) => signIn(input)),
  preview_history: McpToolAccess.readsAsCaller((input) => history(input)),
  preview_recording_start: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  ),
  preview_recording_stop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const { tabId, ...operationInput } = input;
      const response = yield* invoke<unknown>(
        "recordingStop",
        { ...operationInput, transferToEnvironment: true },
        PREVIEW_RECORDING_STOP_TIMEOUT_MS,
        tabId,
      );
      const artifact = yield* claimPreviewRecording(scope.thread.threadId, response.result);
      return { ...artifact, ...(response.toolIcon ? { toolIcon: response.toolIcon } : {}) };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PreviewToolkit.tools>;

const { preview_snapshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(PreviewStandardToolkit, standardHandlers);

export const layerSnapshot = McpToolAccess.toLayer(PreviewSnapshotToolkit, {
  preview_snapshot,
});
