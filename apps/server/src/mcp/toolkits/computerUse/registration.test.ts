import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ServerConfig from "../../../config.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AiError } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectTeamService from "../../../projectTeam/ProjectTeamService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as PreviewBrowser from "../../../preview/PreviewBrowser.ts";
import * as ComputerUseProjectScope from "../../../computerUse/ComputerUseProjectScope.ts";
import * as ComputerUseTurns from "../../../computerUse/ComputerUseTurns.ts";
import * as DesktopComputerUseChannel from "../../../computerUse/DesktopComputerUseChannel.ts";

const layerStubServices = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectTeamService.ProjectTeamService)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
);

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const COMPUTER_TOOLS = [
  "computer_apps",
  "computer_snapshot",
  "computer_click",
  "computer_type",
  "computer_press",
  "computer_scroll",
  "computer_fill",
  "computer_select",
  "computer_invoke_menu",
];

const channelRequests: Array<string> = [];

const layerComputerUse = Layer.mergeAll(
  Layer.succeed(DesktopComputerUseChannel.DesktopComputerUseChannel, {
    available: true,
    request: (method) =>
      Effect.sync(() => {
        channelRequests.push(method);
        return {};
      }),
    configure: () => Effect.void,
    notifications: Stream.empty,
    statusChanges: Stream.empty,
    status: Effect.succeed({ state: "running" as const }),
  }),
  Layer.mock(ComputerUseTurns.ComputerUseTurns)({}),
  ComputerUseProjectScope.layerTest(new Map()),
);

const serve = Effect.gen(function* () {
  const layerRoutes = McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer));
  yield* HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed("environment-scratch" as never),
      }),
    ),
    Layer.provide(PreviewAutomationBroker.layer),
    Layer.provide(PreviewBrowser.layer),
    Layer.provide(layerComputerUse),
    Layer.provide(layerStubServices),
    Layer.build,
  );
});

const rpc = (auth: string) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const init = yield* httpClient.post("/mcp", {
      headers: { accept: "application/json, text/event-stream", authorization: auth },
      body: HttpBody.text(
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"scratch","version":"1.0.0"}}}`,
        "application/json",
      ),
    });
    const sessionId = init.headers["mcp-session-id"];
    let id = 1;
    return (method: string, params: unknown) =>
      Effect.gen(function* () {
        const response = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: auth,
            "mcp-protocol-version": "2025-06-18",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: HttpBody.text(
            JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
            "application/json",
          ),
        });
        const text = yield* response.text;
        return (yield* decodeJson(text.match(/\{.*\}/s)![0])) as {
          readonly result: {
            readonly tools?: ReadonlyArray<{ readonly name: string; readonly description: string }>;
            readonly isError?: boolean;
            readonly structuredContent?: unknown;
          };
        };
      });
  });

const testLayer = Layer.mergeAll(
  NodeHttpServer.layerTest,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-computer-use-mcp-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
);

it.effect("computer_* tools are hidden and refused without the computer-use capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serve;
      channelRequests.length = 0;
      const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-off"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      });
      const call = yield* rpc(credential!.config.authorizationHeader);
      const listed = yield* call("tools/list", {});
      const names = listed.result.tools!.map((tool) => tool.name);
      expect(names).toContain("delegate_task");
      expect(names.filter((name) => name.startsWith("computer_"))).toEqual([]);

      const stale = yield* call("tools/call", {
        name: "computer_snapshot",
        arguments: { app: "TextEdit" },
      });
      expect(stale.result.isError).toBe(true);
      expect(stale.result.structuredContent).toMatchObject({
        code: "computer_use_unavailable",
        details: { reason: "disabled" },
        retryable: false,
      });
      expect(channelRequests).toEqual([]);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("computer_* tools are listed with the computer-use capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serve;
      const credential = yield* McpSessionRegistry.issueActiveMcpCredential({
        threadId: ThreadId.make("thread-on"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set(["computer-use"]),
      });
      const call = yield* rpc(credential!.config.authorizationHeader);
      const listed = yield* call("tools/list", {});
      const tools = listed.result.tools!.filter((tool) => tool.name.startsWith("computer_"));
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(COMPUTER_TOOLS.toSorted());
      for (const tool of tools) {
        expect(tool.description.length, tool.name).toBeLessThanOrEqual(600);
        expect(tool.description, tool.name).toMatch(/background/);
        expect(tool.description, tool.name).toMatch(/computer_snapshot|Call this first/);
        expect(tool.description, tool.name).toMatch(/ref/);
      }
      for (const tool of tools.filter(
        (tool) => tool.name !== "computer_apps" && tool.name !== "computer_snapshot",
      )) {
        expect(tool.description, tool.name).toMatch(
          /Ask the user before deleting, paying, sending, entering credentials, or changing account or security settings\./,
        );
      }
      expect(tools.find((tool) => tool.name === "computer_snapshot")!.description).toMatch(
        /in-app browser/,
      );
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("only argument decoding failures are invalid_argument; others are internal_error", () =>
  Effect.gen(function* () {
    const decode = yield* McpHttpServer.computerUseToolFailure(
      Cause.fail(
        AiError.make({
          module: "Toolkit",
          method: "computer_click.handle",
          reason: new AiError.ToolParameterValidationError({
            toolName: "computer_click",
            description: "app is missing",
          }),
        }),
      ),
    );
    expect(decode.structuredContent).toMatchObject({
      code: "invalid_argument",
      retryable: false,
    });
    const other = yield* McpHttpServer.computerUseToolFailure(Cause.fail(new Error("boom")));
    expect(other.structuredContent).toEqual({
      code: "internal_error",
      message: "BusyBoy hit an internal error running this tool",
      retryable: true,
    });
  }),
);
