import { utilityProcess, type UtilityProcess } from "electron";

import type { SnapShotModifier } from "@t3tools/contracts";

export function startGlobalShiftShortcutProcess(
  workerPath: string,
  modifier: SnapShotModifier,
  onTrigger: () => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  let worker: UtilityProcess;
  try {
    // A utility process, not `child_process.fork`: release builds turn off ELECTRON_RUN_AS_NODE.
    worker = utilityProcess.fork(workerPath, [modifier], {
      serviceName: "BusyBoy Snapshot Shortcut",
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      worker.kill();
    };
    const fail = (error: Error) => {
      if (stopped) return;
      if (settled) {
        stop();
        onFailure(error);
        return;
      }
      settled = true;
      stop();
      reject(error);
    };

    worker.on("message", (message) => {
      if (message === "ready" && !settled) {
        settled = true;
        resolve(stop);
        return;
      }
      if (message !== "trigger" || !settled || stopped) return;
      try {
        onTrigger();
      } catch {}
    });
    worker.once("error", () => {
      fail(new Error("Snapshot shortcut helper crashed"));
    });
    worker.once("exit", (code) => {
      fail(new Error(`Snapshot shortcut helper exited with code ${code}`));
    });
  });
}
