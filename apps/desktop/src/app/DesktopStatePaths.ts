import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(busyboyHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(busyboyHome)) {
    return Option.none();
  }
  const trimmed = busyboyHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly busyboyHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.busyboyHome), () =>
    input.joinPath(input.homeDirectory, ".busyboy"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly busyboyHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.busyboyHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
