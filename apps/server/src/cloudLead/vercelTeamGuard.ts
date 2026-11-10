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
