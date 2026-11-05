// @effect-diagnostics globalTimers:off -- Helper timeouts run at child-process callback boundaries outside Effect fibers.

import { utilityProcess, type UtilityProcess } from "electron";

import type {
  CapturedWindowAccessibilityContext,
  SnapShotAccessibilityRequest,
} from "./SnapShotAccessibility.ts";

const START_TIMEOUT_MS = 1_000;
const RESULT_TIMEOUT_MS = 4_000;

export type AccessibilityRead = {
  readonly started: Promise<void>;
  readonly result: Promise<CapturedWindowAccessibilityContext | undefined>;
};

export type AccessibilityProcess = {
  readonly alive: boolean;
  readonly read: (request: SnapShotAccessibilityRequest) => AccessibilityRead;
  readonly close: () => void;
};

export type AccessibilityProcessPool = {
  readonly warm: () => void;
  readonly cool: () => void;
  readonly read: (request: SnapShotAccessibilityRequest) => AccessibilityRead;
  readonly close: () => void;
};

type AccessibilityMessage =
  | "ready"
  | "started"
  | { readonly type: "result"; readonly context?: CapturedWindowAccessibilityContext };

const completedRead = (context?: CapturedWindowAccessibilityContext): AccessibilityRead => ({
  started: Promise.resolve(),
  result: Promise.resolve(context),
});

const unavailableProcess = (): AccessibilityProcess => ({
  alive: false,
  read: () => completedRead(),
  close: () => undefined,
});

export function startSnapShotAccessibilityProcess(workerPath: string): AccessibilityProcess {
  let worker: UtilityProcess;
  try {
    // A utility process, not `child_process.fork`: fork needs ELECTRON_RUN_AS_NODE, which
    // release builds turn off so no other program can run code as BusyBoy. Utility processes
    // load the worker from the integrity-checked app.asar, and without `disclaim` macOS
    // attributes them to BusyBoy, so they share the app's Accessibility grant.
    worker = utilityProcess.fork(workerPath, ["read"], {
      serviceName: "BusyBoy Snapshot Accessibility",
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch {
    return unavailableProcess();
  }

  let ready = false;
  let request: SnapShotAccessibilityRequest | undefined;
  let startedResolve: (() => void) | undefined;
  let resultResolve: ((value: CapturedWindowAccessibilityContext | undefined) => void) | undefined;
  let startTimeout: ReturnType<typeof setTimeout> | undefined;
  let resultTimeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let settledContext: CapturedWindowAccessibilityContext | undefined;

  const clearTimers = () => {
    if (startTimeout) clearTimeout(startTimeout);
    if (resultTimeout) clearTimeout(resultTimeout);
  };
  const finish = (context?: CapturedWindowAccessibilityContext) => {
    if (settled) return;
    settled = true;
    settledContext = context;
    clearTimers();
    startedResolve?.();
    resultResolve?.(context);
    worker.kill();
  };
  const sendRequest = () => {
    if (!ready || !request || settled) return;
    startTimeout ??= setTimeout(() => finish(), START_TIMEOUT_MS);
    startTimeout.unref();
    try {
      worker.postMessage(request);
    } catch {
      finish();
    }
  };

  worker.on("message", (rawMessage) => {
    const message = rawMessage as AccessibilityMessage;
    if (message === "ready") {
      ready = true;
      sendRequest();
    } else if (message === "started") {
      if (startTimeout) clearTimeout(startTimeout);
      startedResolve?.();
    } else {
      finish(message.context);
    }
  });
  worker.once("error", () => finish());
  worker.once("exit", () => finish());

  return {
    get alive() {
      return !settled;
    },
    read: (nextRequest) => {
      if (settled) return completedRead(settledContext);
      request = nextRequest;
      const started = Promise.withResolvers<void>();
      const result = Promise.withResolvers<CapturedWindowAccessibilityContext | undefined>();
      startedResolve = started.resolve;
      resultResolve = result.resolve;
      resultTimeout = setTimeout(() => finish(), RESULT_TIMEOUT_MS);
      resultTimeout.unref();
      sendRequest();
      return { started: started.promise, result: result.promise };
    },
    close: () => finish(),
  };
}

export function makeSnapShotAccessibilityProcessPool(workerPath: string): AccessibilityProcessPool {
  let standby: AccessibilityProcess | undefined;
  const active = new Set<AccessibilityProcess>();
  let closed = false;

  const warm = () => {
    if (closed || standby?.alive) return;
    standby = startSnapShotAccessibilityProcess(workerPath);
  };
  const cool = () => {
    standby?.close();
    standby = undefined;
  };

  return {
    warm,
    cool,
    read: (request) => {
      if (closed) return completedRead();
      const workerProcess = standby?.alive
        ? standby
        : startSnapShotAccessibilityProcess(workerPath);
      standby = undefined;
      warm();
      active.add(workerProcess);
      const read = workerProcess.read(request);
      void read.result.then(
        () => active.delete(workerProcess),
        () => active.delete(workerProcess),
      );
      return read;
    },
    close: () => {
      if (closed) return;
      closed = true;
      cool();
      for (const workerProcess of active) workerProcess.close();
      active.clear();
    },
  };
}
