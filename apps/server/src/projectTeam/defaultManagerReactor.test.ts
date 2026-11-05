import { assert, describe, it } from "@effect/vitest";
import { type ApplicationStoredEvent, CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { projectThreadDeleteCommandId } from "../orchestration-v2/ProjectCommands.ts";
import { DefaultManagerReactor } from "./defaultManagerReactor.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { defaultPersonaName } from "./persona.ts";
import { PROJECT_ID, SCRATCH_ROOT, START, setUpManager, withTeam } from "./testkit.ts";

const projectCreated = (
  projectId: ProjectId,
  workspaceRoot = "/workspace/new",
): ApplicationStoredEvent =>
  ({
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    payload: { projectId, title: "New", workspaceRoot, createdAt: START },
  }) as unknown as ApplicationStoredEvent;

const threadDeleted = (threadId: ThreadId, commandId: string): ApplicationStoredEvent =>
  ({
    sequence: 7,
    commandId: CommandId.make(commandId),
    event: { type: "thread.deleted", threadId, payload: { id: threadId } },
  }) as unknown as ApplicationStoredEvent;

describe("DefaultManagerReactor", () => {
  it.effect("gives existing projects a PM once, across restarts, and skips deleted ones", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const reactor = yield* DefaultManagerReactor;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const second = ProjectId.make("project-2");
        const deleted = ProjectId.make("project-deleted");
        harness.addProject(second, "Second");
        harness.addProject(deleted, "Gone");
        harness.projects.set(deleted, { ...harness.projects.get(deleted)!, deletedAt: START });

        yield* reactor.ensureAll;
        yield* reactor.ensureAll;

        const managers = yield* repository.listManagers();
        assert.deepStrictEqual(managers.map((manager) => manager.projectId).toSorted(), [
          PROJECT_ID,
          second,
        ]);
        const titles = (yield* Ref.get(harness.dispatched)).flatMap((command) =>
          command.type === "thread.create" ? [command.title] : [],
        );
        assert.deepStrictEqual(
          titles.toSorted(),
          [defaultPersonaName(PROJECT_ID), defaultPersonaName(second)].toSorted(),
        );
      }),
    ),
  );

  it.effect("creates the PM when a project is created", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const reactor = yield* DefaultManagerReactor;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const created = ProjectId.make("project-new");
        harness.addProject(created, "New");

        yield* reactor.handle(projectCreated(created));
        const manager = yield* repository.getManager(created);
        assert.isTrue(Option.isSome(manager));
        assert.strictEqual(
          harness.threads.get(Option.getOrThrow(manager).threadId)?.title,
          defaultPersonaName(created),
        );
      }),
    ),
  );

  it.effect("replaces a deleted PM thread and keeps the PM's settings", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const reactor = yield* DefaultManagerReactor;
        const team = yield* ProjectTeamService.ProjectTeamService;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        const before = yield* team.updateSettings({
          projectId: PROJECT_ID,
          persona: { name: "Ada", voice: "dry" },
          sitrepIntervalMinutes: 30,
          enabled: false,
        });

        harness.threads.get(pm)!.deletedAt = "2026-11-04T00:01:00.000Z";
        yield* reactor.handle(threadDeleted(pm, "delete-pm"));

        const manager = Option.getOrThrow(yield* repository.getManager(PROJECT_ID));
        assert.notStrictEqual(manager.threadId, pm);
        assert.deepStrictEqual(manager.settings, before.settings);
        assert.strictEqual(harness.threads.get(manager.threadId)?.title, "Ada");
      }),
    ),
  );

  it.effect("does not replace the PM while its project is being deleted", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const reactor = yield* DefaultManagerReactor;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const pm = yield* setUpManager;
        const other = ThreadId.make("not-a-pm");
        harness.addThread(other);

        harness.threads.get(pm)!.deletedAt = "2026-11-04T00:01:00.000Z";
        yield* reactor.handle(
          threadDeleted(pm, projectThreadDeleteCommandId("delete-project", pm)),
        );
        yield* reactor.handle(threadDeleted(other, "delete-other"));

        const manager = Option.getOrThrow(yield* repository.getManager(PROJECT_ID));
        assert.strictEqual(manager.threadId, pm);
        const creates = (yield* Ref.get(harness.dispatched)).filter(
          (command) => command.type === "thread.create",
        );
        assert.strictEqual(creates.length, 1);
      }),
    ),
  );

  it.effect("gives No project no PM, removes an old one, and gives a created project its PM", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const reactor = yield* DefaultManagerReactor;
        const team = yield* ProjectTeamService.ProjectTeamService;
        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const scratch = ProjectId.make("project-scratch");
        const pmThreads = () =>
          [...harness.threads.values()].filter(
            (thread) => thread.id.startsWith("project-pm") && thread.deletedAt === null,
          );
        const pmProjects = Effect.map(team.attentionSnapshot, (snapshot) =>
          snapshot.projects.map((summary) => summary.projectId),
        );
        // Only "No project" exists, and an earlier build already gave it a PM.
        harness.projects.clear();
        harness.addScratchProject(scratch);
        const oldPm = (yield* team.ensureManager(scratch)).threadId;

        // On startup that PM is removed: no manager, no live PM thread, no sidebar entry.
        yield* reactor.ensureAll;
        assert.isTrue(Option.isNone(yield* repository.getManager(scratch)));
        assert.strictEqual(harness.threads.get(oldPm)?.deletedAt, START);
        assert.deepStrictEqual(pmThreads(), []);
        assert.deepStrictEqual(yield* pmProjects, []);

        // Deleting the old PM thread and restarting do not bring it back.
        yield* reactor.handle(threadDeleted(oldPm, `project-team:remove-scratch-pm:${oldPm}`));
        yield* reactor.handle(projectCreated(scratch, SCRATCH_ROOT));
        yield* reactor.ensureAll;
        assert.deepStrictEqual(pmThreads(), []);
        assert.deepStrictEqual(yield* pmProjects, []);

        // Creating a project gives that project, and only it, a PM.
        const created = ProjectId.make("project-new");
        harness.addProject(created, "New");
        yield* reactor.handle(projectCreated(created));
        assert.deepStrictEqual(
          pmThreads().map((thread) => thread.projectId),
          [created],
        );
        assert.deepStrictEqual(yield* pmProjects, [created]);
      }),
    ),
  );
});
