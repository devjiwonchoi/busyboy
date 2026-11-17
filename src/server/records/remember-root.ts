import { homedir } from "node:os";
import { join } from "node:path";

import { isTestMode } from "../config";
import { TEST_REMEMBER_ROOT } from "./remember-record";

// why: Test mode keeps records in the temp data folder so a journey never touches the real home.
export function rememberRoot(dataFolder: string): string {
  if (isTestMode()) return join(dataFolder, TEST_REMEMBER_ROOT);
  return process.env.JWN_HOME || join(homedir(), ".jwn");
}
