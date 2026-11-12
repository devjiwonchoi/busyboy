/**
 * Masks secrets before any text from a cloud sandbox (command output, errors,
 * logs) leaves the cloud lead code. Known values are masked exactly; common
 * token shapes are masked even when the value was never registered.
 */

const MASK = "***";
const MIN_SECRET_LENGTH = 8;

/** Not preceded by a word or hyphen character, so "risk-ranked-..." is not read as "sk-...". */
const START = String.raw`(?<![A-Za-z0-9_-])`;

const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(String.raw`${START}sk-ant-[A-Za-z0-9_-]+`, "g"),
  // OpenAI-style keys (sk-..., sk-proj-...); real ones always hold a digit.
  new RegExp(String.raw`${START}sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}`, "g"),
  new RegExp(String.raw`${START}vcp_[A-Za-z0-9]+`, "g"),
  new RegExp(String.raw`${START}github_pat_[A-Za-z0-9_]+`, "g"),
  new RegExp(String.raw`${START}gh[opsu]_[A-Za-z0-9]+`, "g"),
  // Slack tokens.
  new RegExp(String.raw`${START}xox[abprs]-[A-Za-z0-9-]+`, "g"),
  // The password in a URL such as postgres://user:password@host.
  /(?<=:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/g,
];

export interface SecretMasker {
  readonly mask: (text: string) => string;
  readonly maskError: (error: unknown) => Error;
  readonly withSecrets: (secrets: ReadonlyArray<string>) => SecretMasker;
}

export const makeSecretMasker = (secrets: ReadonlyArray<string>): SecretMasker => {
  // Longest first, so a secret that contains another is masked whole.
  const known = [...new Set(secrets.filter((value) => value.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );

  const mask = (text: string): string => {
    let masked = text;
    for (const value of known) masked = masked.split(value).join(MASK);
    for (const pattern of TOKEN_PATTERNS) masked = masked.replace(pattern, MASK);
    return masked;
  };

  const maskError = (error: unknown): Error => {
    if (!(error instanceof Error)) return new Error(mask(String(error)));
    const masked = new Error(mask(error.message));
    masked.name = error.name;
    if (error.stack !== undefined) masked.stack = mask(error.stack);
    if (error.cause !== undefined) masked.cause = maskError(error.cause);
    return masked;
  };

  return {
    mask,
    maskError,
    withSecrets: (more) => makeSecretMasker([...known, ...more]),
  };
};

/** True when the text still holds a known secret or a token-shaped string. */
export const containsSecret = (text: string, secrets: ReadonlyArray<string>): boolean =>
  makeSecretMasker(secrets).mask(text) !== text;
