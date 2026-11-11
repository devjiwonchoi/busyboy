// @effect-diagnostics globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
/**
 * Cloud leads may only touch Vercel teams on this list. The Mac's Vercel CLI
 * token can reach many teams, so every sandbox call first checks, by slug,
 * that the configured team is allowed and that the project belongs to it.
 */
export const ALLOWED_VERCEL_TEAM_SLUGS: ReadonlyArray<string> = ["jiwonchoi"];

export interface VercelTeamInfo {
  /** The slug of the configured team id. */
  readonly teamSlug: string;
  /** The team (account) that owns the configured project id. */
  readonly projectAccountId: string;
}

export interface VercelTeamQuery {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
}

export class VercelTeamNotAllowedError extends Error {
  constructor(detail: string) {
    super(
      `Cloud leads run only in the Vercel team ${ALLOWED_VERCEL_TEAM_SLUGS.join(", ")} (jiwonchoi 팀에서만 돌아요): ${detail}`,
    );
    this.name = "VercelTeamNotAllowedError";
  }
}

/** Reads the team slug and the project's owner from the Vercel API. Reads only. */
export const fetchVercelTeamInfo = async (query: VercelTeamQuery): Promise<VercelTeamInfo> => {
  const get = async (path: string) => {
    const response = await fetch(`https://api.vercel.com${path}`, {
      headers: { Authorization: `Bearer ${query.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Vercel API answered ${response.status} for ${path.split("/")[2]}`);
    }
    return (await response.json()) as Record<string, unknown>;
  };
  const team = await get(`/v2/teams/${encodeURIComponent(query.teamId)}`);
  const project = await get(
    `/v9/projects/${encodeURIComponent(query.projectId)}?teamId=${encodeURIComponent(query.teamId)}`,
  );
  return {
    teamSlug: typeof team.slug === "string" ? team.slug : "",
    projectAccountId: typeof project.accountId === "string" ? project.accountId : "",
  };
};

/** Throws VercelTeamNotAllowedError unless the team is allowed and owns the project. */
export const assertAllowedVercelTeam = async (
  query: VercelTeamQuery,
  lookup: (query: VercelTeamQuery) => Promise<VercelTeamInfo>,
): Promise<void> => {
  let info: VercelTeamInfo;
  try {
    info = await lookup(query);
  } catch (error) {
    throw new VercelTeamNotAllowedError(
      `could not check the team (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!ALLOWED_VERCEL_TEAM_SLUGS.includes(info.teamSlug)) {
    throw new VercelTeamNotAllowedError(`the saved team is "${info.teamSlug || "unknown"}"`);
  }
  if (info.projectAccountId !== query.teamId) {
    throw new VercelTeamNotAllowedError("the saved project is not in that team");
  }
};

/** The project cloud sandboxes run in when none is saved; Vercel makes it for Sandbox. */
export const DEFAULT_SANDBOX_PROJECT = "vercel-sandbox-default-project";

/**
 * Fills in the team and project ids when they are not saved: the allowed team
 * by its slug, and the default sandbox project in it. Reads only, and only the
 * allowed team. Errors say what to do.
 */
export const resolveVercelTarget = async (
  token: string,
  saved: { readonly teamId: string | null; readonly projectId: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<{ readonly teamId: string; readonly projectId: string }> => {
  const get = async (path: string, what: string) => {
    const response = await fetchImpl(`https://api.vercel.com${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `The Vercel login on this Mac has expired or cannot see ${what} (Vercel answered ${response.status}). Run \`npx vercel login\` and try again (Mac의 Vercel 로그인을 다시 해 주세요).`,
      );
    }
    if (response.status === 404) {
      throw new Error(
        `Vercel cannot find ${what}. Create it in the jiwonchoi team, or save vercel_team_id and vercel_project_id (Vercel에서 찾을 수 없어요).`,
      );
    }
    if (!response.ok) throw new Error(`Vercel API answered ${response.status} for ${what}.`);
    return (await response.json()) as { readonly id?: unknown };
  };
  const slug = ALLOWED_VERCEL_TEAM_SLUGS[0]!;
  const teamId =
    saved.teamId ??
    String((await get(`/v2/teams/${encodeURIComponent(slug)}`, `the ${slug} team`)).id);
  const projectId =
    saved.projectId ??
    String(
      (
        await get(
          `/v9/projects/${DEFAULT_SANDBOX_PROJECT}?teamId=${encodeURIComponent(teamId)}`,
          `the ${DEFAULT_SANDBOX_PROJECT} project`,
        )
      ).id,
    );
  return { teamId, projectId };
};
