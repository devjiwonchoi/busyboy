import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { RemoteProcess } from "./RelayClient.ts";
import { remoteCodexStdio, toMacLine, toRemoteLine } from "./codexRemote.ts";

const MAC = "/Users/me/worktrees/task";
const REMOTE = "/vercel/busyboy";
const paths = {
  toRemote: (text: string) =>
    text.split(MAC).join(REMOTE).split("http://127.0.0.1:3773").join("http://127.0.0.1:8788"),
  toMac: (text: string) => text.split(REMOTE).join(MAC),
};

describe("codexRemote", () => {
  it("sends sandbox paths and full access, and reads back Mac paths", () => {
    const turnStart = JSON.stringify({
      id: 3,
      method: "turn/start",
      params: {
        cwd: MAC,
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [MAC] },
        input: [{ type: "text", text: `look at ${MAC}/README.md` }],
      },
    });
    assert.deepEqual(JSON.parse(toRemoteLine(turnStart, paths)), {
      id: 3,
      method: "turn/start",
      params: {
        cwd: REMOTE,
        sandboxPolicy: { type: "dangerFullAccess" },
        input: [{ type: "text", text: `look at ${REMOTE}/README.md` }],
      },
    });

    const threadStart = JSON.stringify({
      id: 2,
      method: "thread/start",
      params: {
        cwd: MAC,
        sandbox: "workspace-write",
        config: { mcp_servers: { "t3-code": { url: "http://127.0.0.1:3773/mcp" } } },
      },
    });
    assert.deepEqual(JSON.parse(toRemoteLine(threadStart, paths)).params, {
      cwd: REMOTE,
      sandbox: "danger-full-access",
      config: { mcp_servers: { "t3-code": { url: "http://127.0.0.1:8788/mcp" } } },
    });

    const fileChange = JSON.stringify({
      method: "item/completed",
      params: { item: { changes: [{ path: `${REMOTE}/src/a.ts` }] } },
    });
    assert.deepEqual(JSON.parse(toMacLine(fileChange, paths)).params.item.changes, [
      { path: `${MAC}/src/a.ts` },
    ]);
  });

  it.effect("carries client lines to the remote codex and its lines back, rewritten", () =>
    Effect.gen(function* () {
      const sent: string[] = [];
      const child = new RemoteProcess((message) => {
        if (message.op === "stdin")
          sent.push(Buffer.from(String(message.data), "base64").toString());
      });
      const { stdio, terminationError } = yield* remoteCodexStdio(child, paths);

      yield* Stream.run(
        Stream.make(`${JSON.stringify({ id: 1, params: { cwd: MAC } })}\n`),
        stdio.stdout(),
      );
      assert.deepEqual(sent, [`${JSON.stringify({ id: 1, params: { cwd: REMOTE } })}\n`]);

      child.stdout.write(`${JSON.stringify({ id: 1, result: { cwd: REMOTE } })}\n`);
      child.handle({ ch: "proc", op: "exit", code: 0, signal: null });
      const received = yield* stdio.stdin.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
      );
      assert.strictEqual(received, `${JSON.stringify({ id: 1, result: { cwd: MAC } })}\n`);
      const error = yield* terminationError;
      assert.strictEqual(error._tag, "CodexAppServerProcessExitedError");
    }).pipe(Effect.scoped),
  );
});
