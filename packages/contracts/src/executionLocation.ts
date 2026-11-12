import * as Schema from "effect/Schema";

/** Where a thread's agent runs: on the user's Mac, or in a cloud sandbox. */
export const ExecutionLocation = Schema.Literals(["local", "cloud"]);
export type ExecutionLocation = typeof ExecutionLocation.Type;
