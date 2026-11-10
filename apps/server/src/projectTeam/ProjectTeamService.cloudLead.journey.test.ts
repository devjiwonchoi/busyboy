// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - drives the promise-based cloud lead runtime against local git repos.
/**
 * A cloud task from start to pull request: the PM starts it in the cloud, the
 * lead's claude runs in a (local, fake) sandbox through the real relay, commits
 * there, and the team's gates read that commit from the Mac mirror mid-turn,
 * so the review, In Review with the pull request, and Ready all pass.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";

import { CloudLeadRuntime } from "../cloudLead/CloudLeadRuntime.ts";
import * as CloudLeadService from "../cloudLead/CloudLeadService.ts";
import type { RemoteProcess } from "../cloudLead/RelayClient.ts";
import { fakeLocalHost, localSandboxClient } from "../cloudLead/testkit.ts";
import { localMirrorShell } from "../cloudLead/WorkspaceMirror.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { approvePlan, createAcceptedTask, setUpManager, withTeam } from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;
const shell = localMirrorShell();
const PR_URL = "https://github.com/devjiwonchoi/busyboy/pull/9001";
const GIT_ENV =
  "export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t";

/** The sandbox's claude: each stdin line "commit <file>" writes and commits that file. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const { execSync } = require("node:child_process");
const fs = require("node:fs");
process.stdout.write("ready\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const file = buffer.slice(0, index).split(" ")[1];
    buffer = buffer.slice(index + 1);
    fs.writeFileSync(file, "hello\\n");
    execSync("git add -A && git commit -qm 'Add " + file + "'");
    process.stdout.write("committed " + execSync("git rev-parse HEAD").toString());
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const outputOf = (child: RemoteProcess) => {
  let text = "";
  child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  return () => text;
};

const waitFor = async (check: () => boolean) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 15_000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const setUpMachines = async () => {
  const root = await NodeFs.mkdtemp(`${NodeOs.tmpdir()}/cloud-journey-`);
  const macHome = `${root}/mac-home`;
  const mac = `${macHome}/worktrees/lead`;
  const binDir = `${root}/bin`;
  await NodeFs.mkdir(binDir, { recursive: true });
  await NodeFs.writeFile(`${binDir}/claude`, FAKE_CLAUDE, { mode: 0o755 });
  await shell.run(
    `mkdir -p '${mac}' && cd '${mac}' && ${GIT_ENV} && git init -q -b main && echo base > README.md && git add . && git commit -qm base && git checkout -qb t3/lead`,
  );
  const client = localSandboxClient({
    binDir,
    makeHome: async (home) => {
      await shell.run(`git clone -q '${mac}' '${home}/busyboy'`);
    },
  });
  const runtime = new CloudLeadRuntime({
    client: async () => client,
    credentials: async () => ({ claudeOauthToken: "sk-ant-oat01-journey", githubToken: null }),
    baseSnapshotId: async () => null,
    host: { ...fakeLocalHost({ files: {} }), env: { HOME: macHome } },
    stateDir: `${root}/state`,
    ports: { relay: await freePort(), mcp: await freePort() },
  });
  const cleanup = async () => {
    await runtime.releaseAll();
    await NodeFs.rm(root, { recursive: true, force: true });
  };
  return { mac, client, runtime, cleanup };
};

const gitHead = (path: string) => shell.run(`git -C '${path}' rev-parse HEAD`).then((out) => out.trim());

describe("cloud task journey", () => {
  it.effect("starts in the cloud and reaches a linked pull request from the sandbox's commit", () =>
    Effect.acquireUseRelease(
      Effect.promise(setUpMachines),
      ({ mac, client, runtime }) =>
        withTeam(
          (harness) =>
            Effect.gen(function* () {
              const team = yield* service;
              const pm = yield* setUpManager;
              const { task: created } = yield* createAcceptedTask(pm, {
                title: "Add hello.txt",
                request: "Add hello.txt.",
                intake: "New work.",
              });

              // The PM starts the task in the cloud.
              const { task, leadThreadId: lead } = yield* team.startTask(
                pm,
                { taskId: created.id, location: "cloud" },
                harness.delegate,
              );
              assert.strictEqual((yield* Ref.get(harness.delegated)).at(-1)?.location, "cloud");
              assert.strictEqual(task.location, "cloud");
              // What delegate_task creates: a cloud thread on its own Mac worktree.
              const thread = harness.addThread(lead);
              thread.worktreePath = mac;
              thread.branch = "t3/lead";
              thread.shell = { location: "cloud" };
              // The gates read the Mac worktree's real HEAD, like WorktreeHeadReader.
              harness.worktreeHead = (path) =>
                NodeChildProcess.execFileSync("git", ["-C", path, "rev-parse", "HEAD"])
                  .toString()
                  .trim();
              yield* approvePlan(lead);

              // The adapter's part of a turn: claude runs in the sandbox and commits there.
              const launch = yield* CloudLeadService.hooksFromRuntime(runtime).prepare({
                threadId: lead,
                worktreePath: mac,
                mcpEndpoint: "http://127.0.0.1:1/mcp",
              });
              const child = launch.spawn({ command: "claude", args: [], env: {} });
              const output = outputOf(child);
              yield* Effect.promise(() => waitFor(() => output().includes("ready")));
              child.stdin.write("commit hello.txt\n");
              yield* Effect.promise(() => waitFor(() => output().includes("committed")));
              const sandboxHead = output().split("committed ")[1]!.trim();
              assert.notStrictEqual(yield* Effect.promise(() => gitHead(mac)), sandboxHead);

              // Mid-turn, the lead records its review and ships: the gates mirror the
              // sandbox first, so the Mac worktree they read is at the sandbox's commit.
              yield* team.setEvidence(lead, { criterionId: "c1", evidence: "hello.txt exists" });
              // Review is the one step a cloud task hands off; it reads the mirror locally.
              yield* team.delegateStep(
                lead,
                { role: "review", task: "Review main...HEAD." },
                harness.delegate,
              );
              assert.strictEqual((yield* Ref.get(harness.delegated)).at(-1)?.location, undefined);
              assert.strictEqual(yield* Effect.promise(() => gitHead(mac)), sandboxHead);
              assert.isTrue(
                (yield* Effect.promise(() => NodeFs.readFile(`${mac}/hello.txt`, "utf8"))) ===
                  "hello\n",
              );

              yield* team.setReview(lead, { clean: true, findings: "", head: sandboxHead });
              yield* team.updateTask(lead, { stage: "in_review", prUrl: PR_URL });
              harness.shipStates.set(PR_URL, {
                state: "open",
                isDraft: true,
                headSha: sandboxHead,
                mergeability: "mergeable",
                checks: [{ name: "test", status: "success" }],
                unresolvedThreads: 0,
              });
              yield* team.markTaskReady(lead, { head: sandboxHead, localChecks: "" });

              const { task: shipped } = yield* team.readTask(pm, { taskId: task.id });
              assert.strictEqual(shipped.stage, "in_review");
              assert.strictEqual(shipped.prUrl, PR_URL);
              assert.strictEqual(shipped.location, "cloud");
              assert.strictEqual(shipped.ready?.head, sandboxHead);
              assert.deepEqual(harness.markedReady, [PR_URL]);
              assert.strictEqual(client.created.length, 1);

              child.stdin.end();
            }),
          { cloudLead: CloudLeadService.hooksFromRuntime(runtime) },
        ),
      ({ cleanup }) => Effect.promise(cleanup),
    ),
  );
});
