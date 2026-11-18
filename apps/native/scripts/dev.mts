import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

import { DEV_RUN_ENV } from "../dev-run.ts";

const electron = createRequire(import.meta.url)("electron") as string;
const child = spawn(electron, [join(import.meta.dirname, "..")], {
  stdio: "inherit",
  env: { ...process.env, [DEV_RUN_ENV]: "1" },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
