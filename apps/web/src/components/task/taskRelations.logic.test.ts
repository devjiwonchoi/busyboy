import type { EnvironmentId, ProjectTaskReference } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  blockedByLabel,
  blockedByShortLabel,
  buildTaskRelationsIndex,
  taskRelations,
} from "./taskRelations.logic";

const ENV = "env-1" as EnvironmentId;

function task(
  id: string,
  number: number,
  overrides: Partial<ProjectTaskReference> = {},
): ProjectTaskReference {
  return {
    id: id as never,
    number,
    parentTaskId: null,
    waitsOn: [],
    title: `Task ${number}`,
    stage: "inbox",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    iterateRound: 0,
    shipRound: 0,
    modelSteps: {},
    updatedAt: null,
    ...overrides,
  };
}

const index = buildTaskRelationsIndex([
  {
    environmentId: ENV,
    summary: {
      projectId: "busyboy" as never,
      taskKeyPrefix: "BU",
      tasks: [
        task("epic", 53, { title: "Director" }),
        task("model", 55, { parentTaskId: "epic" as never, stage: "done", title: "Model" }),
        task("intake", 56, { parentTaskId: "epic" as never, waitsOn: ["model" as never] }),
        task("ui", 57, {
          parentTaskId: "epic" as never,
          waitsOn: ["model" as never, "server" as never],
          stage: "running",
        }),
        task("dropped", 60, { parentTaskId: "epic" as never, stage: "cancelled" }),
      ],
    },
  },
  {
    environmentId: ENV,
    summary: {
      projectId: "site" as never,
      taskKeyPrefix: "SI",
      tasks: [task("server", 4, { title: "Server" })],
    },
  },
]);

describe("taskRelations", () => {
  it("counts finished subtasks and leaves cancelled ones out", () => {
    const epic = taskRelations(index, ENV, "epic" as never);
    expect(epic.subtasks.map((related) => related.key)).toEqual(["BU-55", "BU-56", "BU-57"]);
    expect(epic.progress).toEqual({ done: 1, total: 3 });
  });

  it("is blocked only by unfinished waits-on tasks, across projects", () => {
    const ui = taskRelations(index, ENV, "ui" as never);
    expect(ui.parent?.key).toBe("BU-53");
    expect(ui.blockedBy.map((related) => related.key)).toEqual(["SI-4"]);
    expect(ui.related.map((related) => related.key)).toEqual(["BU-55"]);
    expect(blockedByLabel(ui.blockedBy)).toBe("Blocked by SI-4 · Server");
    expect(blockedByShortLabel(ui.blockedBy)).toBe("Blocked by SI-4");
  });

  it("lists the tasks a task blocks, and none once it is done", () => {
    expect(
      taskRelations(index, ENV, "server" as never).blocking.map((related) => related.key),
    ).toEqual(["BU-57"]);
    const model = taskRelations(index, ENV, "model" as never);
    expect(model.blocking).toEqual([]);
    expect(model.related.map((related) => related.key)).toEqual(["BU-56", "BU-57"]);
    expect(taskRelations(index, ENV, "intake" as never).blockedBy).toEqual([]);
  });
});
