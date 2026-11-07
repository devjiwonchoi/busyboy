// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ProjectId, TASK_PROPOSAL_ACCEPT, TASK_PROPOSAL_DISMISS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { directorWorkspaceRoot } from "./director.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { PROJECT_ID, setUpManager, startLead, withTeam } from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;
const proposal = {
  title: "로그인 고치기",
  request: "로그인 오류를 수정한다.",
  intake: "기존 태스크에 없는 새 오류다.",
  goal: "사용자가 로그인할 수 있다.",
  verification: "로그인 회귀 테스트가 통과한다.",
};

// Read hidden proposals through persistence; task tools must refuse them until acceptance.
const storedTask = (
  taskId: Parameters<ProjectTeamRepository.ProjectTeamRepository["Service"]["getTask"]>[0],
) =>
  Effect.flatMap(ProjectTeamRepository.ProjectTeamRepository, (repository) =>
    repository.getTask(taskId),
  ).pipe(Effect.map(Option.getOrThrow));

const proposalCard = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const team = yield* service;
    const snapshot = yield* team.attentionSnapshot;
    const card = snapshot.projects
      .find((project) => project.projectId === projectId)
      ?.decisionCards.find((entry) => entry.item.kind === "proposal");
    if (card === undefined) {
      throw new Error("Expected a task proposal card.");
    }
    return card;
  });

describe("ProjectTeamService task proposals", () => {
  it.effect(
    "keeps a PM proposal off task lists and shows its goal and verification on the card",
    () =>
      withTeam(() =>
        Effect.gen(function* () {
          const team = yield* service;
          const pm = yield* setUpManager;
          const { task } = yield* team.createTask(pm, proposal);
          assert.strictEqual(task.stage, "proposed");
          assert.deepStrictEqual((yield* team.listTasks(pm, {})).tasks, []);
          const project = (yield* team.attentionSnapshot).projects[0]!;
          assert.deepStrictEqual(project.tasks, []);
          const card = yield* proposalCard(PROJECT_ID);
          assert.strictEqual(card.item.taskId, task.id);
          assert.strictEqual(card.item.kind, "proposal");
          assert.strictEqual(card.item.answeredAt, null);
          assert.strictEqual(card.item.question, proposal.title);
          assert.strictEqual(card.item.summary, proposal.goal);
          assert.strictEqual(card.item.verification, proposal.verification);
          assert.strictEqual(card.item.askerThreadId, pm);
          assert.deepStrictEqual(card.item.options, [TASK_PROPOSAL_ACCEPT, TASK_PROPOSAL_DISMISS]);
          assert.deepStrictEqual(card.proposal, { projectId: PROJECT_ID });
        }),
      ),
  );

  it.effect("requires goal and verification from a PM", () =>
    withTeam(() =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        for (const input of [
          {
            title: proposal.title,
            request: proposal.request,
            intake: proposal.intake,
            verification: proposal.verification,
          },
          {
            title: proposal.title,
            request: proposal.request,
            intake: proposal.intake,
            goal: proposal.goal,
          },
        ]) {
          const error = yield* Effect.flip(team.createTask(pm, input));
          assert.include(error.message, "needs goal and verification");
        }
        assert.deepStrictEqual((yield* team.attentionSnapshot).projects[0]!.decisionCards, []);
      }),
    ),
  );

  it.effect("refuses task_start and PM attention_answer on an unaccepted proposal", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, proposal);
        const start = yield* Effect.flip(team.startTask(pm, { taskId: task.id }, harness.delegate));
        assert.include(start.message, "proposal the user has not added yet");
        const card = yield* proposalCard(PROJECT_ID);
        const answer = yield* Effect.flip(
          team.answerAttention(pm, {
            attentionItemId: card.item.id,
            answer: TASK_PROPOSAL_ACCEPT,
          }),
        );
        assert.include(answer.message, "Only the user can add a proposed task");
        assert.strictEqual((yield* storedTask(task.id)).stage, "proposed");
        assert.strictEqual((yield* proposalCard(PROJECT_ID)).item.answeredAt, null);
        assert.deepStrictEqual(yield* Ref.get(harness.delegated), []);
      }),
    ),
  );

  it.effect(
    "leaves proposals open while answering ordinary decisions after the AFK grace period",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const pm = yield* setUpManager;
          const lead = yield* startLead(pm, "Ordinary task", harness.delegate);
          yield* team.updateSettings({ projectId: PROJECT_ID, afk: { hours: null } });
          const decision = yield* team.askUser(lead.leadThreadId, {
            kind: "decision",
            question: "Which list?",
            options: ["Grouped (Recommended)", "Flat"],
          });
          const { task } = yield* team.createTask(pm, proposal);
          yield* TestClock.adjust("61 seconds");
          yield* team.afkSweep;
          const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
          const answered = Option.getOrThrow(yield* repository.getAttentionItem(decision.item.id));
          assert.isString(answered.answeredAt);
          assert.strictEqual(answered.answer, "Grouped (Recommended)");
          assert.include(
            (yield* Ref.get(harness.sent))
              .filter((message) => message.threadId === lead.leadThreadId)
              .map((message) => message.text),
            "[Auto-answered (AFK): the user is away] Which list? → Grouped (Recommended)",
          );
          assert.strictEqual((yield* proposalCard(PROJECT_ID)).item.answeredAt, null);
          assert.strictEqual((yield* storedTask(task.id)).stage, "proposed");
        }),
      ),
  );

  it.effect("adds an accepted proposal to inbox and tells its PM to start it", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, proposal);
        const card = yield* proposalCard(PROJECT_ID);
        const { item } = yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: card.item.id,
          answer: TASK_PROPOSAL_ACCEPT,
        });
        assert.isString(item.answeredAt);
        assert.strictEqual(item.answeredBy, "user");
        assert.strictEqual((yield* storedTask(task.id)).stage, "inbox");
        assert.deepStrictEqual(
          (yield* team.listTasks(pm, {})).tasks.map((entry) => entry.id),
          [task.id],
        );
        const sent = yield* Ref.get(harness.sent);
        assert.isTrue(
          sent.some(
            (message) => message.threadId === pm && message.text.startsWith("[제안 승인됨]"),
          ),
        );
      }),
    ),
  );

  it.effect("finishes accepting an open card whose task already moved to inbox", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task } = yield* team.createTask(pm, proposal);
        const card = yield* proposalCard(PROJECT_ID);
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        yield* repository.updateTask({ id: task.id, stage: "inbox", now: task.updatedAt });

        const { item } = yield* team.answerDecision({
          projectId: PROJECT_ID,
          attentionItemId: card.item.id,
          answer: TASK_PROPOSAL_ACCEPT,
        });
        assert.isString(item.answeredAt);
        assert.strictEqual((yield* storedTask(task.id)).stage, "inbox");
        assert.isTrue(
          (yield* Ref.get(harness.sent)).some(
            (message) => message.threadId === pm && message.text.startsWith("[제안 승인됨]"),
          ),
        );
      }),
    ),
  );

  for (const [answer, prefix] of [
    [TASK_PROPOSAL_DISMISS, "[제안 빠짐]"],
    ["태스크로 추가\n범위를 줄여주세요", "[제안 피드백]"],
    ["빼기\n대신 모바일만 해주세요", "[제안 피드백]"],
    ["모바일 로그인만 수정해줘", "[제안 피드백]"],
  ] as const) {
    it.effect(`closes a proposal with ${prefix} and keeps it hidden`, () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const pm = yield* setUpManager;
          const { task } = yield* team.createTask(pm, proposal);
          const card = yield* proposalCard(PROJECT_ID);
          const { item } = yield* team.answerDecision({
            projectId: PROJECT_ID,
            attentionItemId: card.item.id,
            answer,
          });
          assert.isString(item.answeredAt);
          assert.strictEqual(item.answeredBy, "user");
          assert.strictEqual((yield* storedTask(task.id)).stage, "proposed");
          assert.deepStrictEqual((yield* team.listTasks(pm, {})).tasks, []);
          assert.strictEqual((yield* team.attentionSnapshot).projects[0]!.openCount, 0);
          const message = (yield* Ref.get(harness.sent)).find(
            (entry) => entry.threadId === pm && entry.text.startsWith(prefix),
          );
          assert.isDefined(message);
          if (prefix === "[제안 피드백]") {
            assert.include(message!.text, answer);
          }
        }),
      ),
    );
  }

  it.effect(
    "shows a routed Director proposal in its own chat and wakes the target PM only on acceptance",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const pm = yield* setUpManager;
          const directorProject = ProjectId.make("project-director");
          harness.addProject(directorProject, "Director");
          const config = yield* ServerConfig.ServerConfig;
          harness.projects.set(directorProject, {
            ...harness.projects.get(directorProject)!,
            workspaceRoot: directorWorkspaceRoot(NodePath as unknown as Path.Path, config.baseDir),
          });
          const director = yield* team.ensureManager(directorProject);
          const { task } = yield* team.createTask(director.threadId, {
            ...proposal,
            projectId: PROJECT_ID,
          });
          assert.strictEqual(task.projectId, PROJECT_ID);
          assert.strictEqual(task.stage, "proposed");
          const card = yield* proposalCard(directorProject);
          assert.strictEqual(card.item.projectId, directorProject);
          assert.strictEqual(card.item.askerThreadId, director.threadId);
          assert.deepStrictEqual(card.proposal, { projectId: PROJECT_ID });
          assert.deepStrictEqual(
            (yield* team.attentionSnapshot).projects.find(
              (project) => project.projectId === PROJECT_ID,
            )!.decisionCards,
            [],
          );
          assert.isFalse(
            (yield* harness.messagesTo(pm)).some((text) =>
              text.startsWith("[Director added task]"),
            ),
          );
          yield* team.answerDecision({
            projectId: directorProject,
            attentionItemId: card.item.id,
            answer: TASK_PROPOSAL_ACCEPT,
          });
          assert.strictEqual((yield* storedTask(task.id)).stage, "inbox");
          assert.deepStrictEqual(
            (yield* team.listTasks(pm, {})).tasks.map((entry) => entry.id),
            [task.id],
          );
          assert.isTrue(
            (yield* harness.messagesTo(pm)).some(
              (text) =>
                text.startsWith("[Director added task]") &&
                text.includes(proposal.title) &&
                text.includes("task_start"),
            ),
          );
          assert.isTrue(
            (yield* Ref.get(harness.sent)).some(
              (message) =>
                message.threadId === director.threadId && message.text.startsWith("[제안 승인됨]"),
            ),
          );
        }),
      ),
  );

  it.effect("asks the Director to propose project tasks after its epic is accepted", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const directorProject = ProjectId.make("project-director");
        harness.addProject(directorProject, "Director");
        const config = yield* ServerConfig.ServerConfig;
        harness.projects.set(directorProject, {
          ...harness.projects.get(directorProject)!,
          workspaceRoot: directorWorkspaceRoot(NodePath as unknown as Path.Path, config.baseDir),
        });
        const director = yield* team.ensureManager(directorProject);
        const { task } = yield* team.createTask(director.threadId, proposal);
        const card = yield* proposalCard(directorProject);
        yield* team.answerDecision({
          projectId: directorProject,
          attentionItemId: card.item.id,
          answer: TASK_PROPOSAL_ACCEPT,
        });
        assert.strictEqual((yield* storedTask(task.id)).stage, "inbox");
        const relay = (yield* Ref.get(harness.sent)).find(
          (message) =>
            message.threadId === director.threadId && message.text.startsWith("[제안 승인됨]"),
        )?.text;
        assert.isDefined(relay);
        assert.strictEqual(
          relay!.split("\n")[1],
          `The user added this epic. Now propose one task per project with task_create(projectId, parentTaskId: ${task.id}).`,
        );
        assert.strictEqual(relay!.includes("task_start"), false);
      }),
    ),
  );

  it.effect("keeps lead task_create under its own task and refuses other parents or projects", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const parent = yield* startLead(pm, "Parent", harness.delegate);
        const other = yield* team.createTaskForUser({
          projectId: PROJECT_ID,
          title: "Other",
          context: "Another task",
          startPlanning: false,
        });
        const { task } = yield* team.createTask(parent.leadThreadId, {
          title: "Child",
          request: "Do a step.",
        });
        assert.strictEqual(task.parentTaskId, parent.task.id);
        assert.strictEqual(task.stage, "inbox");
        const otherParent = yield* Effect.flip(
          team.createTask(parent.leadThreadId, {
            title: "Wrong parent",
            request: "No.",
            parentTaskId: other.task.id,
          }),
        );
        assert.include(otherParent.message, "subtasks of its own task only");
        const otherProject = yield* Effect.flip(
          team.createTask(parent.leadThreadId, {
            title: "Wrong project",
            request: "No.",
            projectId: ProjectId.make("project-other"),
          }),
        );
        assert.include(otherProject.message, "own project only");
        assert.deepStrictEqual((yield* team.attentionSnapshot).projects[0]!.decisionCards, []);
      }),
    ),
  );
});
