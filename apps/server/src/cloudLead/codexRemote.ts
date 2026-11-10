/**
 * Talks to a `codex app-server` running in a cloud sandbox over the relay.
 *
 * Codex takes the working directory and the t3-code MCP URL inside its
 * JSON-RPC messages, not on its command line, so every message to it is
 * rewritten to sandbox paths, and every message from it back to Mac paths.
 * Codex's own sandbox cannot start in the VM, so turns ask for full access:
 * the VM is the sandbox.
 */
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";

import type { CloudLaunch } from "./CloudLeadRuntime.ts";
import type { RemoteProcess } from "./RelayClient.ts";

const mapStrings = (value: unknown, map: (text: string) => string): unknown => {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, mapStrings(nested, map)]),
  );
};

/** One JSON-RPC line to the sandbox: sandbox paths, and full access in place of Codex's sandbox. */
export const toRemoteLine = (line: string, paths: CloudLaunch["paths"]): string => {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return paths.toRemote(line);
  }
  const mapped = mapStrings(message, paths.toRemote) as { params?: Record<string, unknown> };
  const params = mapped.params;
  if (params !== undefined && params !== null && typeof params === "object") {
    if ("sandboxPolicy" in params) params.sandboxPolicy = { type: "dangerFullAccess" };
    if ("sandbox" in params) params.sandbox = "danger-full-access";
  }
  return JSON.stringify(mapped);
};

/** One JSON-RPC line from the sandbox, with Mac paths, so diffs and file links read the mirror. */
export const toMacLine = (line: string, paths: CloudLaunch["paths"]): string => {
  try {
    return JSON.stringify(mapStrings(JSON.parse(line), paths.toMac));
  } catch {
    return paths.toMac(line);
  }
};

/** Splits a byte stream into lines and maps each one. */
const lineMapper = (map: (line: string) => string) => {
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    push: (chunk: Uint8Array | string): string => {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let out = "";
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        out += `${line.trim().length === 0 ? line : map(line)}\n`;
      }
      return out;
    },
    flush: (): string => {
      const rest = buffer;
      buffer = "";
      return rest.trim().length === 0 ? rest : map(rest);
    },
  };
};

const encoder = new TextEncoder();

/**
 * The codex client's stdio over a remote process, and the error to report
 * once it exits. Stdio here is from the client's side: its stdin is codex's stdout.
 */
export const remoteCodexStdio = Effect.fn("remoteCodexStdio")(function* (
  child: RemoteProcess,
  paths: CloudLaunch["paths"],
) {
  const fromCodex = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const exited = yield* Latch.make(false);
  let exitCode = 0;
  const incoming = lineMapper((line) => toMacLine(line, paths));
  child.stdout.on("data", (chunk: Buffer) => {
    const out = incoming.push(chunk);
    if (out.length > 0) Queue.offerUnsafe(fromCodex, encoder.encode(out));
  });
  child.stderr.resume();
  child.once("exit", (code: number | null) => {
    exitCode = code ?? 1;
    const rest = incoming.flush();
    if (rest.length > 0) Queue.offerUnsafe(fromCodex, encoder.encode(rest));
    Queue.endUnsafe(fromCodex);
    exited.openUnsafe();
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
    }),
  );
  const outgoing = lineMapper((line) => toRemoteLine(line, paths));
  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(fromCodex),
    stdout: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() => {
          const out = outgoing.push(chunk);
          if (out.length > 0) child.stdin.write(out);
        }),
      ),
    stderr: () => Sink.drain,
  });
  const terminationError: Effect.Effect<CodexErrors.CodexAppServerError> = exited.await.pipe(
    Effect.map(() => new CodexErrors.CodexAppServerProcessExitedError({ code: exitCode })),
  );
  return { stdio, terminationError };
});
