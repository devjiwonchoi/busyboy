// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - A plain Node evaluation harness.
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";

export interface Mac {
  osascript(script: string): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  run(cmd: string, args: string[]): Promise<string>;
  homeDir(): string;
  now(): Date;
}

export function realMac(): Mac {
  const exec = promisify(execFile);
  const run = async (cmd: string, args: string[]) => {
    const { stdout } = await exec(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  };

  return {
    run,
    osascript: (script) => run("/usr/bin/osascript", ["-e", script]),
    readFile: (path) => fs.readFile(path, "utf8"),
    writeFile: (path, text) => fs.writeFile(path, text, "utf8"),
    removeFile: (path) => fs.rm(path, { force: true }),
    mkdirp: async (path) => {
      await fs.mkdir(path, { recursive: true });
    },
    exists: async (path) => {
      try {
        await fs.stat(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
    homeDir: homedir,
    now: () => new Date(),
  };
}
