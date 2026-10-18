// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
type Environment = Readonly<Record<string, string | undefined>>;
export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: { readonly baseEnv?: Environment; readonly repoRoot?: string } = {}): Record<
  string,
  string | undefined
> {
  const read = (name: string) => {
    const file = NodePath.join(repoRoot, name);
    return NodeFS.existsSync(file) ? NodeUtil.parseEnv(NodeFS.readFileSync(file, "utf8")) : {};
  };
  return { ...read(".env"), ...read(".env.local"), ...baseEnv };
}
