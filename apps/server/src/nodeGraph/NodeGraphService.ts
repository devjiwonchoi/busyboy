// @effect-diagnostics nodeBuiltinImport:off - stat keys the parse cache; the readers it calls are plain async functions.
import { stat } from "node:fs/promises";
import { join } from "node:path";

import {
  type NodeAsk,
  type NodeGraph,
  NodeGraphError,
  type NodeGraphUnlinkedAsk,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { type ChangedFiles, changedFiles, changesFor } from "./actualChanges.ts";
import { type AskSource, linkThread, toAsk } from "./asks.ts";
import { buildGraph, type GraphEntry, listRecordDirs, readRecordFiles } from "./graph.ts";
import { type ParsedRecord, parseRecord, RECORD_FILES } from "./parseJwn.ts";
import { observeTimeline } from "./timeline.ts";

/** Git reads run on at most this many checkouts at once. */
const GIT_CONCURRENCY = 4;

/** Reads each checkout's changed files once, a few at a time. */
const changedFilesByCheckout = async (
  checkouts: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, ChangedFiles>> => {
  const queue = [...new Set(checkouts)];
  const results = new Map<string, ChangedFiles>();
  const worker = async () => {
    for (let checkout = queue.shift(); checkout !== undefined; checkout = queue.shift()) {
      results.set(checkout, await changedFiles(checkout));
    }
  };
  await Promise.all(Array.from({ length: Math.min(GIT_CONCURRENCY, queue.length) }, worker));
  return results;
};

/** How often the harness looks at records so the timeline grows while nobody is watching. */
const OBSERVE_INTERVAL = "60 seconds";

export class NodeGraphService extends Context.Service<
  NodeGraphService,
  {
    /** Reads every record into the node graph, with actual file changes. */
    readonly get: () => Effect.Effect<NodeGraph, NodeGraphError>;
    /** Reads the records and grows each node's timeline, skipping git. */
    readonly observe: () => Effect.Effect<void, NodeGraphError>;
  }
>()("t3/nodeGraph/NodeGraphService") {}

const toError = (message: string) => (cause: unknown) =>
  new NodeGraphError({
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const nodesHome = join(config.baseDir, "nodes");
  // Parsing is cached per folder until a record file's modification time changes.
  const cache = new Map<string, { readonly key: string; readonly parsed: ParsedRecord }>();

  const modifiedKey = async (path: string) =>
    (
      await Promise.all(
        RECORD_FILES.map((name) =>
          stat(join(path, name)).then(
            (info) => `${name}:${info.mtimeMs}:${info.size}`,
            () => `${name}:-`,
          ),
        ),
      )
    ).join("|");

  const readRecords = Effect.gen(function* () {
    const rows = yield* projects
      .list()
      .pipe(Effect.mapError(toError("프로젝트 목록을 읽지 못했습니다")));
    return yield* Effect.tryPromise({
      try: async () => {
        const dirs = await listRecordDirs({
          projects: rows.map((row) => ({
            projectId: row.projectId,
            workspaceRoot: row.workspaceRoot,
          })),
          nodesHome,
        });
        // Forget folders that are gone so the cache cannot grow for the life of the server.
        const present = new Set(dirs.map((dir) => dir.path));
        for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
        return Promise.all(
          dirs.map(async (dir) => {
            const key = await modifiedKey(dir.path);
            const cached = cache.get(dir.path);
            if (cached?.key === key) return { dir, parsed: cached.parsed };
            const parsed = parseRecord(dir.nodeId, await readRecordFiles(dir.path));
            cache.set(dir.path, { key, parsed });
            return { dir, parsed };
          }),
        );
      },
      catch: toError("기록을 읽지 못했습니다"),
    });
  });

  /** Pending questions from every thread, plus answered ones from threads a record names. */
  const readAsks = (
    records: ReadonlyArray<{
      readonly dir: { readonly nodeId: string; readonly dirName: string };
      readonly parsed: ParsedRecord;
    }>,
  ) =>
    Effect.gen(function* () {
      const linkable = records.map((record) => ({
        nodeId: record.dir.nodeId,
        dirName: record.dir.dirName,
        statusText: record.parsed.statusText,
      }));
      const snapshot = yield* threads.getShellSnapshot();
      const candidates = snapshot.threads.filter(
        (shell) =>
          shell.deletedAt === null &&
          (shell.pendingRuntimeRequest?.kind === "user_input" ||
            linkThread(shell.id, linkable) !== null),
      );
      const byNode = new Map<string, Array<NodeAsk>>();
      const unlinked: Array<NodeGraphUnlinkedAsk> = [];
      for (const shell of candidates) {
        const { runtimeRequests, turnItems } = yield* threads.getThreadRecords(
          shell.id,
          ["runtimeRequests", "turnItems"],
          { turnItemTypes: ["user_input_request"] },
        );
        const nodeId = linkThread(shell.id, linkable);
        for (const request of runtimeRequests) {
          const item = turnItems.find(
            (candidate) =>
              candidate.type === "user_input_request" && candidate.requestId === request.id,
          );
          const source: AskSource = {
            threadId: shell.id as ThreadId,
            request,
            questions: item?.type === "user_input_request" ? item.questions : [],
          };
          const ask = toAsk(source);
          if (ask === null) continue;
          if (nodeId !== null) byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), ask]);
          else if (ask.answer === null)
            unlinked.push({ projectId: shell.projectId as ProjectId, ask });
        }
      }
      return { byNode, unlinked };
    }).pipe(Effect.mapError(toError("질문 기록을 읽지 못했습니다")));

  const build = (withChanges: boolean) =>
    Effect.gen(function* () {
      const records = yield* readRecords;
      const { byNode, unlinked } = yield* readAsks(records);
      const changed = withChanges
        ? yield* Effect.tryPromise({
            try: () =>
              changedFilesByCheckout(
                records
                  .filter((record) => (record.parsed.contract?.expectedFiles.length ?? 0) > 0)
                  .map((record) => record.dir.workdir),
              ),
            catch: toError("실제 변경을 읽지 못했습니다"),
          })
        : new Map<string, ChangedFiles>();
      const entries: ReadonlyArray<GraphEntry> = records.map((record) => {
        const checkout = changed.get(record.dir.workdir);
        return {
          ...record,
          asks: byNode.get(record.dir.nodeId) ?? [],
          changes: !withChanges
            ? ({ kind: "unavailable", reason: "변경 비교는 그래프를 읽을 때만 합니다." } as const)
            : changesFor(
                record.parsed.contract?.expectedFiles ?? [],
                // Only checkouts with a file tree were read; without one, changesFor says so.
                checkout ?? { kind: "unavailable", reason: "변경 파일 목록을 읽지 않았습니다." },
              ),
        };
      });
      const graph = buildGraph(entries, unlinked);
      const now = DateTime.formatIso(yield* DateTime.now);
      const nodes = yield* Effect.tryPromise({
        try: () =>
          Promise.all(
            graph.nodes.map(async (node) => ({
              ...node,
              timeline: await observeTimeline({
                nodesHome,
                nodeId: node.id,
                status: node.status,
                now,
              }),
            })),
          ),
        catch: toError("과정 타임라인을 쓰지 못했습니다"),
      });
      return { ...graph, nodes };
    });

  // One build at a time, so a read and the observer never append the same timeline entry twice.
  const buildLock = yield* Semaphore.make(1);
  const get: NodeGraphService["Service"]["get"] = () =>
    buildLock.withPermits(1)(build(true)).pipe(Effect.withSpan("NodeGraphService.get"));
  const observe: NodeGraphService["Service"]["observe"] = () =>
    Effect.asVoid(buildLock.withPermits(1)(build(false)));

  return { get, observe } satisfies NodeGraphService["Service"];
});

export const layer = Layer.effect(NodeGraphService, make);

/** Observes records on an interval so the timeline grows between reads. */
export const layerObserver = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* NodeGraphService;
    yield* service.observe().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Node graph observation failed", { cause })),
      Effect.delay(OBSERVE_INTERVAL),
      Effect.repeat(Schedule.spaced(OBSERVE_INTERVAL)),
      Effect.forkScoped,
    );
  }),
);
