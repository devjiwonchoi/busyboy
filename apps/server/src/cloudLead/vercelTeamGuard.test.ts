// @effect-diagnostics globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_SANDBOX_PROJECT, resolveVercelTarget } from "./vercelTeamGuard.ts";

const vercel = (routes: Record<string, { status: number; body?: unknown }>) => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const path = String(input).replace("https://api.vercel.com", "");
    seen.push(path);
    const route = routes[path] ?? { status: 500 };
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status });
  }) as typeof fetch;
  return { seen, fetchImpl };
};

describe("resolveVercelTarget", () => {
  it("looks up the jiwonchoi team and its sandbox project when nothing is saved", async () => {
    const { seen, fetchImpl } = vercel({
      "/v2/teams/jiwonchoi": { status: 200, body: { id: "team_personal" } },
      [`/v9/projects/${DEFAULT_SANDBOX_PROJECT}?teamId=team_personal`]: {
        status: 200,
        body: { id: "prj_sandbox" },
      },
    });
    expect(await resolveVercelTarget("t", { teamId: null, projectId: null }, fetchImpl)).toEqual({
      teamId: "team_personal",
      projectId: "prj_sandbox",
    });
    expect(seen).toHaveLength(2);
  });

  it("keeps saved ids without asking Vercel", async () => {
    const { seen, fetchImpl } = vercel({});
    expect(
      await resolveVercelTarget("t", { teamId: "team_saved", projectId: "prj_saved" }, fetchImpl),
    ).toEqual({ teamId: "team_saved", projectId: "prj_saved" });
    expect(seen).toEqual([]);
  });

  it("says when the Mac's Vercel login expired, and when the project is missing", async () => {
    await expect(
      resolveVercelTarget(
        "t",
        { teamId: null, projectId: null },
        vercel({ "/v2/teams/jiwonchoi": { status: 403 } }).fetchImpl,
      ),
    ).rejects.toThrow(/Vercel login on this Mac has expired.*npx vercel login/);
    await expect(
      resolveVercelTarget("t", { teamId: "team_saved", projectId: null }, vercel({}).fetchImpl),
    ).rejects.toThrow(/answered 500/);
    await expect(
      resolveVercelTarget(
        "t",
        { teamId: "team_saved", projectId: null },
        vercel({ [`/v9/projects/${DEFAULT_SANDBOX_PROJECT}?teamId=team_saved`]: { status: 404 } })
          .fetchImpl,
      ),
    ).rejects.toThrow(/Vercel cannot find the vercel-sandbox-default-project project/);
  });
});
