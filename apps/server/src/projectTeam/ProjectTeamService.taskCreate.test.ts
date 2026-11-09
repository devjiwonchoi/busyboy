import { assert, describe, it } from "@effect/vitest";
import { OrchestratorMcpFailure, type ProjectTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  DIRECTOR_PROJECT_ID,
  SECOND_PROJECT_ID,
  setUpManager,
  setUpWorkspace,
  startLead,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;
const request = {
  title: "로그인 고치기",
  request: "로그인 오류를 수정한다.",
  intake: "기존 태스크에 없는 새 오류다.",
  goal: "사용자가 로그인할 수 있다.",
  verification: "로그인 회귀 테스트가 통과한다.",
};

const openCards = Effect.gen(function* () {
  const team = yield* service;
  return (yield* team.attentionSnapshot).projects.flatMap((project) => project.decisionCards);
});

const notes = (taskId: ProjectTaskId) =>
  Effect.gen(function* () {
    const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
    const events = yield* repository.listTaskEvents({ taskId, limit: 50 });
    return events.filter((event) => event.kind === "note").map((event) => event.body);
  });

describe("ProjectTeamService task_create", () => {
  it.effect("starts a PM's task at once, with no proposal card", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const result = yield* team.createTask(pm, request, harness.delegate);
        assert.strictEqual(result.task.stage, "planning");
        assert.isNotNull(result.task.leadThreadId);
        assert.isUndefined(result.waiting);
        assert.deepStrictEqual(yield* openCards, []);
        assert.strictEqual((yield* Ref.get(harness.delegated)).length, 1);
        assert.include(result.task.request, `Goal: ${request.goal}`);
      }),
    ),
  );

  it.effect("keeps a PM's task in Todo with the reason while every slot is busy", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        yield* team.updateSettingsAsManager(pm, { maxConcurrentTasks: 1 });
        yield* startLead(pm, "Running", harness.delegate);
        const result = yield* team.createTask(pm, request, harness.delegate);
        assert.strictEqual(result.task.stage, "inbox");
        assert.strictEqual(result.task.leadThreadId, null);
        assert.include(result.waiting ?? "", "1 of 1 task leads are already running");
        assert.isTrue(
          (yield* notes(result.task.id)).some((text) => text.startsWith("Waiting in Todo:")),
        );
        assert.deepStrictEqual(yield* openCards, []);
        assert.strictEqual((yield* Ref.get(harness.delegated)).length, 1);
      }),
    ),
  );

  it.effect("keeps a PM's task in Todo while a task it waits on is unfinished", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const first = yield* startLead(pm, "First", harness.delegate);
        const result = yield* team.createTask(
          pm,
          { ...request, waitsOn: [first.task.id] },
          harness.delegate,
        );
        assert.strictEqual(result.task.stage, "inbox");
        assert.include(result.waiting ?? "", "waits on");
      }),
    ),
  );

  it.effect("reports a lead that fails to start as an error, not as waiting", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const failing: ProjectTeamService.DelegateTaskLead = () =>
          Effect.fail(
            new OrchestratorMcpFailure({ code: "invalid_request", message: "provider down" }),
          );
        const error = yield* Effect.flip(team.createTask(pm, request, failing));
        assert.include(error.message, "provider down");
        const [task] = (yield* team.listTasks(pm, {})).tasks;
        assert.strictEqual(task?.stage, "inbox");
        assert.isFalse(
          (yield* notes(task!.id)).some((text) => text.startsWith("Waiting in Todo:")),
        );
      }),
    ),
  );

  it.effect("puts the Director's task in the project's Todo and wakes its PM to start it", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { secondPm, director } = yield* setUpWorkspace(harness);
        const { task } = yield* team.createTask(
          director.threadId,
          { ...request, projectId: SECOND_PROJECT_ID },
          harness.delegate,
        );
        assert.strictEqual(task.projectId, SECOND_PROJECT_ID);
        assert.strictEqual(task.stage, "inbox");
        assert.deepStrictEqual(yield* openCards, []);
        // The Director cannot start leads; the project's PM does.
        assert.deepStrictEqual(yield* Ref.get(harness.delegated), []);
        const wake = (yield* harness.messagesTo(secondPm)).find((text) =>
          text.startsWith("[Director added task]"),
        );
        assert.isDefined(wake);
        assert.include(wake!, request.title);
        assert.include(wake!, `start it now with task_start (taskId: ${task.id})`);
        assert.deepStrictEqual(
          (yield* team.listTasks(secondPm, {})).tasks.map((entry) => entry.id),
          [task.id],
        );
      }),
    ),
  );

  it.effect("creates the Director's epic right away", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { director } = yield* setUpWorkspace(harness);
        const { task: epic } = yield* team.createTask(
          director.threadId,
          { ...request, title: "로그인 전면 개편" },
          harness.delegate,
        );
        assert.strictEqual(epic.projectId, DIRECTOR_PROJECT_ID);
        assert.strictEqual(epic.stage, "inbox");
        const { task: child } = yield* team.createTask(director.threadId, {
          ...request,
          projectId: SECOND_PROJECT_ID,
          parentTaskId: epic.id,
        });
        assert.strictEqual(child.parentTaskId, epic.id);
        assert.deepStrictEqual(yield* openCards, []);
        assert.deepStrictEqual(yield* Ref.get(harness.delegated), []);
      }),
    ),
  );
});
