import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { BUSYBOY_PROJECT_FILE_NAME, type BusyboyProjectFile } from "@busyboy/contracts";
import { BusyboyProjectFileFromJson } from "@busyboy/shared/busyboyProjectFile";

const decodeBusyboyProjectFileJson = Schema.decodeEffect(BusyboyProjectFileFromJson);

export class BusyboyProjectFileLoadError extends Schema.TaggedError<BusyboyProjectFileLoadError>()(
  "BusyboyProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${BUSYBOY_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

export class BusyboyProjectFileLoader extends Context.Service<
  BusyboyProjectFileLoader,
  {
    /**
     * Never fails: missing, unreadable, or invalid files resolve to `Option.none` (invalid files
     * are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<BusyboyProjectFile>>;
  }
>()("busyboy/project/BusyboyProjectFileLoader") {}

const logBusyboyProjectFileLoadError = (error: BusyboyProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: BusyboyProjectFileLoader["Service"]["load"] = Effect.fn("BusyboyProjectFileLoader.load")(
    function* (workspaceRoot) {
      const filePath = path.join(workspaceRoot, BUSYBOY_PROJECT_FILE_NAME);
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.asSome,
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : logBusyboyProjectFileLoadError(
                  new BusyboyProjectFileLoadError({
                    operation: "read",
                    workspaceRoot,
                    filePath,
                    cause: error,
                  }),
                ).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) {
        return Option.none<BusyboyProjectFile>();
      }
      return yield* decodeBusyboyProjectFileJson(raw.value).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) =>
            logBusyboyProjectFileLoadError(
              new BusyboyProjectFileLoadError({
                operation: "decode",
                workspaceRoot,
                filePath,
                cause: error,
              }),
            ).pipe(Effect.as(Option.none<BusyboyProjectFile>())),
        }),
      );
    },
  );

  return BusyboyProjectFileLoader.of({ load });
});

export const layer = Layer.effect(BusyboyProjectFileLoader, make);
