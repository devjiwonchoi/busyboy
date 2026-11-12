// @effect-diagnostics nodeBuiltinImport:off - builds throwaway repositories and a nodes home on disk.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { buildGraph, listRecordDirs, readRecordFiles } from "./graph.ts";
import { parseRecord } from "./parseJwn.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "node-graph-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

const NO_CHANGES = { kind: "unavailable", reason: "test" } as const;

const scan = async () => {
  const dirs = await listRecordDirs({
    projects: [
      { projectId: ProjectId.make("project-web"), workspaceRoot: join(root, "web") },
      { projectId: ProjectId.make("project-api"), workspaceRoot: join(root, "api") },
    ],
    nodesHome: join(root, "home/nodes"),
    worktreesOf: async () => [],
  });
  const entries = await Promise.all(
    dirs.map(async (dir) => ({
      dir,
      parsed: parseRecord(dir.nodeId, await readRecordFiles(dir.path)),
      asks: [],
      changes: NO_CHANGES,
    })),
  );
  return { dirs, graph: buildGraph(entries) };
};

describe("node graph across repositories", () => {
  beforeEach(() => {
    write(
      "api/.jwn/push/ALIGN.md",
      "# ALIGN: Push service\n# Success criteria\n## 1 · Sends pushes\n## 2 · Retries\n",
    );
    write(
      "api/.jwn/push/VERIFY.md",
      "| Criterion | Result | Evidence |\n| --- | --- | --- |\n| 1 | pass | [log](logs/run.txt) |\n",
    );
    write(
      "web/.jwn/notify/ALIGN.md",
      [
        "# ALIGN: Phone notifications",
        "Parent: launch",
        "Waits on: api/push criterion 1, api/push criterion 2",
        "# Success criteria",
        "## 1 · Notifies within a minute",
      ].join("\n"),
    );
    write("web/.jwn/empty-folder/notes.txt", "not a record");
    write(
      "home/nodes/launch/ALIGN.md",
      "# ALIGN: Mobile launch\n# Success criteria\n## 1 · Web and API work together\n",
    );
  });

  it("finds records in every project and parent nodes in the nodes home", async () => {
    const { dirs } = await scan();
    expect(dirs.map((dir) => [dir.nodeId, dir.projectId])).toEqual([
      ["web/notify", "project-web"],
      ["api/push", "project-api"],
      ["launch", null],
    ]);
  });

  it("links criteria across repositories and shows the node waiting until all are proven", async () => {
    const { graph } = await scan();
    expect(graph.edges).toEqual([
      { from: "web/notify", to: "api/push", criterion: "1", satisfied: true },
      { from: "web/notify", to: "api/push", criterion: "2", satisfied: false },
    ]);
    const notify = graph.nodes.find((node) => node.id === "web/notify");
    expect(notify?.status.dots.waiting).toBe(true);
    expect(notify?.contract?.parent).toBe("launch");
    expect(graph.nodes.find((node) => node.id === "api/push")?.status.dots.waiting).toBe(false);
  });

  it("stops waiting once the criterion it waits on is proven", async () => {
    write(
      "api/.jwn/push/VERIFY.md",
      "| Criterion | Result | Evidence |\n| --- | --- | --- |\n| 1 | pass | [log](logs/run.txt) |\n| 2 | pass | [log](logs/run.txt) |\n",
    );
    const { graph } = await scan();
    expect(graph.edges.every((edge) => edge.satisfied)).toBe(true);
    expect(graph.nodes.find((node) => node.id === "web/notify")?.status.dots.waiting).toBe(false);
  });

  it("marks a dependency on a node or criterion that does not exist", async () => {
    write(
      "web/.jwn/notify/ALIGN.md",
      "# ALIGN: Notify\nWaits on: api/missing criterion 1, api/push criterion 9\n# Success criteria\n## 1 · Works\n",
    );
    const { graph } = await scan();
    const notify = graph.nodes.find((node) => node.id === "web/notify");
    expect(notify?.issues.map((issue) => issue.kind)).toEqual([
      "unresolved_dependency",
      "unresolved_dependency",
    ]);
    expect(notify?.status.dots.waiting).toBe(true);
  });

  it("keeps a node whose record file cannot be read, with the reason", async () => {
    mkdirSync(join(root, "api/.jwn/push/STATUS.md"));
    const { graph } = await scan();
    expect(graph.nodes.find((node) => node.id === "api/push")?.issues).toEqual([
      expect.objectContaining({ kind: "unreadable_file", file: "STATUS.md" }),
    ]);
  });
});

describe("stable node ids", () => {
  it("skips a worktree listing that is the project root and suffixes shared repo names by path", async () => {
    write("one/app/.jwn/task/ALIGN.md", "# ALIGN: One\n# Success criteria\n## 1 · Works\n");
    write("two/app/.jwn/task/ALIGN.md", "# ALIGN: Two\n# Success criteria\n## 1 · Works\n");
    const projects = [
      { projectId: ProjectId.make("project-one"), workspaceRoot: join(root, "one/app") },
      { projectId: ProjectId.make("project-two"), workspaceRoot: join(root, "two/app") },
    ];
    // git lists the main checkout too; it must not show up twice.
    const scanIds = async (order: typeof projects) =>
      (
        await listRecordDirs({
          projects: order,
          nodesHome: join(root, "home/nodes"),
          worktreesOf: async (projectRoot) => [projectRoot],
        })
      ).map((dir) => [dir.projectId, dir.nodeId]);

    const forward = await scanIds(projects);
    expect(forward).toHaveLength(2);
    expect(forward.every(([, id]) => /^app-[0-9a-f]{6}\/task$/.test(String(id)))).toBe(true);
    expect(new Set(await scanIds(projects.toReversed()))).toEqual(new Set(forward));
  });
});

describe("checkouts shared between projects", () => {
  it("gives a checkout to the project whose root it is, whatever the project order", async () => {
    write("main/.jwn/task/ALIGN.md", "# ALIGN: Main\n# Success criteria\n## 1 · Works\n");
    write("side/.jwn/task/ALIGN.md", "# ALIGN: Side\n# Success criteria\n## 1 · Works\n");
    const main = { projectId: ProjectId.make("project-main"), workspaceRoot: join(root, "main") };
    const side = { projectId: ProjectId.make("project-side"), workspaceRoot: join(root, "side") };
    const scanFor = async (order: ReadonlyArray<typeof main>) =>
      (
        await listRecordDirs({
          projects: order,
          nodesHome: join(root, "home/nodes"),
          // "side" is also listed as a worktree of "main".
          worktreesOf: async (projectRoot) =>
            projectRoot === main.workspaceRoot ? [side.workspaceRoot] : [],
        })
      ).map((dir) => [dir.nodeId, dir.projectId]);
    const expected = [
      ["main/task", "project-main"],
      ["side/task", "project-side"],
    ];
    expect(await scanFor([main, side])).toEqual(expected);
    expect(new Set(await scanFor([side, main]))).toEqual(new Set(expected));
  });

  it("keeps ids unique when two worktrees share a folder name", async () => {
    write("repo/.jwn/task/ALIGN.md", "# ALIGN: Root\n# Success criteria\n## 1 · Works\n");
    write("a/wt/.jwn/task/ALIGN.md", "# ALIGN: A\n# Success criteria\n## 1 · Works\n");
    write("b/wt/.jwn/task/ALIGN.md", "# ALIGN: B\n# Success criteria\n## 1 · Works\n");
    const ids = (
      await listRecordDirs({
        projects: [
          { projectId: ProjectId.make("project-repo"), workspaceRoot: join(root, "repo") },
        ],
        nodesHome: join(root, "home/nodes"),
        worktreesOf: async () => [join(root, "a/wt"), join(root, "b/wt")],
      })
    ).map((dir) => dir.nodeId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});
