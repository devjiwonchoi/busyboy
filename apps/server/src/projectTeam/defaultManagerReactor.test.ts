import { assert, describe, it } from "@effect/vitest";
import { type ApplicationStoredEvent, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { DefaultManagerReactor } from "./defaultManagerReactor.ts";
import { defaultPersonaName } from "./persona.ts";
import { PROJECT_ID, START, withTeam } from "./testkit.ts";

const projectCreated = (projectId: ProjectId): ApplicationStoredEvent =>
  ({
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    payload: { projectId, title: "New", workspaceRoot: "/workspace/new", createdAt: START },
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
});
