/**
 * Local Claude config holds absolute Mac paths (plugin install paths,
 * marketplace locations, hooks). The sandbox has a different home, so these
 * rewrite them before the files are copied over.
 */

export interface HomeMapping {
  readonly localHome: string;
  readonly remoteHome: string;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const trimTrailingSlash = (value: string) =>
  value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;

/**
 * Replaces the local home only where it is a whole path prefix, so
 * "/Users/me" does not match inside "/Users/me2".
 */
export const rewriteHomePaths = (text: string, mapping: HomeMapping): string => {
  const localHome = trimTrailingSlash(mapping.localHome);
  const remoteHome = trimTrailingSlash(mapping.remoteHome);
  const pattern = new RegExp(`${escapeRegExp(localHome)}(?=[/"'\\s\\\\]|$)`, "g");
  return text.replace(pattern, remoteHome);
};

/** Claude names ~/.claude/projects/<dir> after the cwd: every non-alphanumeric char becomes "-". */
export const encodeProjectDir = (absolutePath: string): string =>
  trimTrailingSlash(absolutePath).replace(/[^a-zA-Z0-9]/g, "-");

export const remapProjectMemoryDir = (localCwd: string, remoteCwd: string) => ({
  from: encodeProjectDir(localCwd),
  to: encodeProjectDir(remoteCwd),
});
