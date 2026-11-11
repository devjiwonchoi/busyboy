/**
 * The Vercel CLI login on this Mac. Its token expires within hours and the CLI
 * renews it from a refresh token whenever it runs, so an expired login is
 * renewed by running the CLI once before the token is used.
 */

/** Where the CLI keeps its login, relative to HOME. */
export const VERCEL_CLI_AUTH = "Library/Application Support/com.vercel.cli/auth.json";

/** A token this close to expiring is renewed first. */
const RENEW_BEFORE_MS = 10 * 60 * 1000;

export interface VercelCliLoginDeps {
  readonly readAuthFile: () => Promise<string>;
  /** Runs the CLI (e.g. `vercel whoami`), which renews an expired token. */
  readonly renew: () => Promise<void>;
  readonly now?: () => number;
}

const parse = (raw: string): { readonly token: string; readonly expiresAtMs: number | null } | null => {
  try {
    const auth = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown };
    if (typeof auth.token !== "string" || auth.token.length === 0) return null;
    // Older logins have no expiry; the CLI writes seconds.
    const expiresAtMs = typeof auth.expiresAt === "number" ? auth.expiresAt * 1000 : null;
    return { token: auth.token, expiresAtMs };
  } catch {
    return null;
  }
};

/** The CLI token, renewed first when it has expired or is about to; null without a login. */
export const readVercelCliLogin = async (deps: VercelCliLoginDeps): Promise<string | null> => {
  const now = deps.now ?? Date.now;
  const read = () => deps.readAuthFile().then(parse, () => null);
  const login = await read();
  if (login === null) return null;
  if (login.expiresAtMs === null || login.expiresAtMs - now() > RENEW_BEFORE_MS) return login.token;
  await deps.renew().catch(() => undefined);
  const renewed = await read();
  if (renewed === null || (renewed.expiresAtMs !== null && renewed.expiresAtMs <= now())) {
    throw new Error(
      "The Vercel login on this Mac has expired and could not be renewed. Run `npx vercel login` and try again (Mac의 Vercel 로그인이 만료됐어요. 다시 로그인해 주세요).",
    );
  }
  return renewed.token;
};
