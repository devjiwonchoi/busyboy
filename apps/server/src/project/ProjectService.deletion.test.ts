import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const layerEventPersistence = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);
const layerServices = Layer.mergeAll(
  layerEventPersistence,
  ProjectionMaintenance.layer.pipe(Layer.provide(layerEventPersistence)),
  ProjectStore.layer,
  CommandReceiptStore.layer,
  IdAllocator.layer,
  Layer.succeed(WorkspacePaths.WorkspacePaths, {
    normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
      Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
  }),
).pipe(
  Layer.provideMerge(
    ProjectEnrichmentService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
            resolve: () => Effect.succeed(null),
          }),
          Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
            resolvePath: () => Effect.succeed(null),
          }),
        ),
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
);
const layerDatabase = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "project-deletion-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const seedProject = Effect.fn("ProjectDeletionTest.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Deletion test', ${`/work/${projectId}`}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
});

it.effect(
  "clears a deleted project's settings overrides so a machine-disabled instance cannot stay alive",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:overrides-cleanup");
      const instanceId = ProviderInstanceId.make("codex_work");
      yield* seedProject(projectId);

      yield* Effect.gen(function* () {
        const service = yield* ProjectService.make;
        const serverSettings = yield* ServerSettings.ServerSettingsService;
        yield* serverSettings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
          },
        });

        yield* service.delete({
          commandId: CommandId.make("command:overrides-cleanup:project-delete"),
          projectId,
        });

        const settingsAfterDelete = yield* serverSettings.getSettings;
        assert.isUndefined(settingsAfterDelete.projectSettingsOverrides[projectId]);
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);
