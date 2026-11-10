import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import { makeSandboxClient, type SandboxSdk, type SdkSandbox } from "./SandboxClient.ts";

const VERCEL_TOKEN = "vercel-token-value-123";
const CLAUDE_TOKEN = "sk-ant-oat01-secretvalue";

const fakeSdk = (
  stdout: (env: Record<string, string>) => string,
  lookupTeam: SandboxSdk["lookupTeam"] = async (query) => ({
    teamSlug: "jiwonchoi",
    projectAccountId: query.teamId,
  }),
) => {
  const calls = {
    sdk: 0,
    lookups: 0,
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
    extendTimeout: async () => undefined,
    snapshot: async () => ({ snapshotId: "snap", sizeBytes: 1, status: "created" }),
    stop: async () => undefined,
    delete: async () => undefined,
  };
  const sdk: SandboxSdk = {
    createSandbox: async (params) => {
      calls.sdk += 1;
      calls.create.push(params);
      return sandbox;
    },
    getSandbox: async () => {
      calls.sdk += 1;
      return sandbox;
    },
    getSnapshot: async () => {
      calls.sdk += 1;
      throw new Error(`lookup failed with token ${VERCEL_TOKEN}`);
    },
    lookupTeam: async (query) => {
      calls.lookups += 1;
      return lookupTeam(query);
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

describe("makeSandboxClient team guard", () => {
  const otherTeam: SandboxSdk["lookupTeam"] = async (query) => ({
    teamSlug: "vercel",
    projectAccountId: query.teamId,
  });

  it("refuses every sandbox call for a team outside the allowlist without calling the SDK", async () => {
    const { sdk, calls } = fakeSdk(() => "", otherTeam);
    const client = makeSandboxClient(credentials, sdk);

    await expect(client.create({ vcpus: 1, timeoutMs: 1 })).rejects.toThrow(
      /jiwonchoi 팀에서만 돌아요.*"vercel"/,
    );
    await expect(client.get("sbx")).rejects.toThrow(/jiwonchoi 팀에서만 돌아요/);
    await expect(client.snapshotState("snap")).rejects.toThrow(/jiwonchoi 팀에서만 돌아요/);
    expect(calls.sdk).toBe(0);
  });

  it("refuses a project that belongs to another team", async () => {
    const { sdk, calls } = fakeSdk(
      () => "",
      async () => ({
        teamSlug: "jiwonchoi",
        projectAccountId: "team_other",
      }),
    );
    await expect(
      makeSandboxClient(credentials, sdk).create({ vcpus: 1, timeoutMs: 1 }),
    ).rejects.toThrow(/project is not in that team/);
    expect(calls.sdk).toBe(0);
  });

  it("refuses when the team cannot be checked, masks the token, and checks again next time", async () => {
    let fail = true;
    const { sdk, calls } = fakeSdk(
      () => "",
      async (query) => {
        if (fail) throw new Error(`network down for ${query.token}`);
        return { teamSlug: "jiwonchoi", projectAccountId: query.teamId };
      },
    );
    const client = makeSandboxClient(credentials, sdk);

    const failure = await client.create({ vcpus: 1, timeoutMs: 1 }).catch((error: Error) => error);
    expect((failure as Error).message).toMatch(/jiwonchoi 팀에서만 돌아요.*could not check/);
    expect((failure as Error).message).not.toContain(VERCEL_TOKEN);
    expect(calls.sdk).toBe(0);

    fail = false;
    await client.create({ vcpus: 1, timeoutMs: 1 });
    await client.get("sbx");
    expect(calls.lookups).toBe(2);
    expect(calls.sdk).toBe(2);
  });
});
