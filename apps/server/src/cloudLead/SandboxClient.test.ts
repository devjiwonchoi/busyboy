import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import { makeSandboxClient, type SandboxSdk, type SdkSandbox } from "./SandboxClient.ts";

const VERCEL_TOKEN = "vercel-token-value-123";
const CLAUDE_TOKEN = "sk-ant-oat01-secretvalue";

const fakeSdk = (stdout: (env: Record<string, string>) => string) => {
  const calls = {
    create: [] as Array<Record<string, unknown>>,
    commands: [] as Array<{ cmd: string; args?: string[]; env?: Record<string, string> }>,
    writes: [] as Array<{ path: string; content: Buffer }>,
  };
  const sandbox: SdkSandbox = {
    name: "sbx",
    runCommand: async (params) => {
      calls.commands.push(params);
      const env = params.env ?? {};
      return {
        exitCode: params.args?.includes("fail") ? 3 : 0,
        stdout: async () => stdout(env),
        stderr: async () => `stderr ${env.CLAUDE_CODE_OAUTH_TOKEN ?? ""}`,
      };
    },
    writeFiles: async (files) => void calls.writes.push(...files),
    readFileToBuffer: async () => null,
    domain: (port) => `https://sbx-${port}.vercel.run`,
    snapshot: async () => ({ snapshotId: "snap", sizeBytes: 1, status: "created" }),
    stop: async () => undefined,
    delete: async () => undefined,
  };
  const sdk: SandboxSdk = {
    createSandbox: async (params) => {
      calls.create.push(params);
      return sandbox;
    },
    getSandbox: async () => sandbox,
    getSnapshot: async () => {
      throw new Error(`lookup failed with token ${VERCEL_TOKEN}`);
    },
  };
  return { sdk, calls };
};

const credentials = { token: Redacted.make(VERCEL_TOKEN), teamId: "team", projectId: "prj" };

describe("makeSandboxClient", () => {
  it("passes secrets only as command env and masks them in output", async () => {
    const { sdk, calls } = fakeSdk((env) => `token is ${env.CLAUDE_CODE_OAUTH_TOKEN}`);
    const client = makeSandboxClient(credentials, sdk);
    const sandbox = await client.create({ vcpus: 2, timeoutMs: 1000 });
    const result = await sandbox.runCommand({
      cmd: "claude",
      args: ["-p", "hi"],
      env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN },
    });

    expect(calls.commands[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN });
    expect(calls.commands[0]?.args).toEqual(["-p", "hi"]);
    expect(result.stdout).toBe("token is ***");
    expect(result.stderr).toBe("stderr ***");
    expect(calls.create[0]).toMatchObject({ resources: { vcpus: 2 }, timeout: 1000 });
  });

  it("refuses to write a known secret into a file", async () => {
    const { sdk, calls } = fakeSdk(() => "");
    const sandbox = await makeSandboxClient(credentials, sdk).create({ vcpus: 1, timeoutMs: 1 });
    await sandbox.runCommand({ cmd: "true", env: { GITHUB_TOKEN: "github-secret-xyz" } });

    await expect(
      sandbox.writeFiles([{ path: "/tmp/a", content: Buffer.from("x github-secret-xyz") }]),
    ).rejects.toThrow(/Refusing to write a secret into \/tmp\/a/);
    await expect(
      sandbox.writeFiles([{ path: "/tmp/b", content: Buffer.from(`t=${VERCEL_TOKEN}`) }]),
    ).rejects.toThrow(/Refusing/);
    expect(calls.writes).toEqual([]);

    await sandbox.writeFiles([{ path: "/tmp/c", content: Buffer.from("fine") }]);
    expect(calls.writes.map((file) => file.path)).toEqual(["/tmp/c"]);
  });

  it("masks secrets in thrown errors and in failed sh scripts", async () => {
    const { sdk } = fakeSdk((env) => env.CLAUDE_CODE_OAUTH_TOKEN ?? "");
    const client = makeSandboxClient(credentials, sdk);
    const sandbox = await client.create({ vcpus: 1, timeoutMs: 1 });
    const failure = await sandbox
      .sh("fail", { env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN } })
      .catch((error: Error) => error);
    expect(String((failure as Error).message)).toContain("exit 3");
    expect(String((failure as Error).message)).not.toContain(CLAUDE_TOKEN);

    expect(client.masker().mask(`${VERCEL_TOKEN} ${CLAUDE_TOKEN}`)).toBe("*** ***");
  });

  it("reports a snapshot it cannot load as missing", async () => {
    const { sdk } = fakeSdk(() => "");
    expect(await makeSandboxClient(credentials, sdk).snapshotState("snap")).toBe("missing");
  });
});
