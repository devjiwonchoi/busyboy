// @effect-diagnostics nodeBuiltinImport:off - builds a throwaway project and BusyBoy home on disk.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeGraph, ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as NodeGraphService from "./NodeGraphService.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "node-graph-service-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

const projectId = ProjectId.make("project-busyboy");
const leadThread = ThreadId.make("thread-lead-notify");
const strayThread = ThreadId.make("thread-elsewhere");
const createdAt = DateTime.makeUnsafe("2026-11-12T09:00:00.000Z");

const pendingQuestion = (id: string) => ({
  runtimeRequests: [
    {
      id: RuntimeRequestId.make(id),
      kind: "user_input",
      status: "pending",
      createdAt,
      resolvedAt: null,
    },
  ],
  turnItems: [
    {
      type: "user_input_request",
      requestId: RuntimeRequestId.make(id),
      questions: [
        {
          id: "q1",
          header: "알림",
          question: "이 끝 상태로 갈까요?",
          options: [{ label: "합의 (추천)", description: "진행" }],
        },
      ],
    },
  ],
});

const layer = () =>
  NodeGraphService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(root, join(root, "home")).pipe(Layer.provide(NodeServices.layer)),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          list: () =>
            Effect.succeed([
              { projectId, workspaceRoot: join(root, "busyboy") } as ProjectStore.ProjectRow,
            ]),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              threads: [
                { id: leadThread, projectId, deletedAt: null, pendingRuntimeRequest: null },
                {
                  id: strayThread,
                  projectId,
                  deletedAt: null,
                  pendingRuntimeRequest: { kind: "user_input" },
                },
              ],
            } as never),
          getThreadRecords: ((threadId: ThreadId) =>
            Effect.succeed(
              pendingQuestion(threadId === leadThread ? "request-lead" : "request-stray") as never,
            )) as never,
        }),
      ),
    ),
  );

describe("NodeGraphService", () => {
  it.effect("serves the graph of a registered project with its cards, issues and timeline", () =>
    Effect.gen(function* () {
      write(
        "busyboy/.jwn/notify/ALIGN.md",
        "# ALIGN: Notify\nVersion: 1 · Status: approved by user on 2026-11-12\n# Success criteria\n## 1 · Notifies\n",
      );
      write("busyboy/.jwn/notify/STATUS.md", `- Owning chat: ${leadThread}\n- State: running\n`);
      write("busyboy/.jwn/old/STATUS.md", "- State: done\n");

      const service = yield* NodeGraphService.NodeGraphService;
      const graph = yield* service.get();

      expect(Schema.decodeUnknownExit(NodeGraph)(JSON.parse(JSON.stringify(graph)))._tag).toBe(
        "Success",
      );
      expect(graph.nodes.map((node) => node.id)).toEqual(["busyboy/notify", "busyboy/old"]);
      const notify = graph.nodes[0]!;
      expect(notify.status.asks.map((ask) => ask.id)).toEqual(["request-lead"]);
      expect(notify.status.state).toBe("asking");
      expect(notify.status.dots.ask).toBe(true);
      expect(notify.status.progress).toEqual({ proven: 0, total: 1 });
      expect(notify.timeline).toHaveLength(1);
      expect(notify.status.changes).toEqual({
        kind: "unavailable",
        reason: "ALIGN.md에 파일 트리가 없습니다.",
      });
      expect(graph.nodes[1]?.issues.map((issue) => issue.kind)).toEqual(["missing_contract"]);
      expect(graph.unlinkedAsks).toEqual([
        { projectId, ask: expect.objectContaining({ id: "request-stray", answer: null }) },
      ]);
    }).pipe(Effect.provide(layer())),
  );
});
