import Constants from "expo-constants";

export interface TracingPublicConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

type ExpoExtra =
  | {
      readonly observability?: {
        readonly tracesUrl?: unknown;
        readonly tracesDataset?: unknown;
        readonly tracesToken?: unknown;
      };
    }
  | undefined;

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSecureUrl(value: unknown): string | null {
  const raw = trimNonEmpty(value);
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveTracingPublicConfig(
  extra: ExpoExtra = Constants.expoConfig?.extra as ExpoExtra,
): TracingPublicConfig | null {
  const tracesUrl = normalizeSecureUrl(extra?.observability?.tracesUrl);
  const tracesDataset = trimNonEmpty(extra?.observability?.tracesDataset);
  const tracesToken = trimNonEmpty(extra?.observability?.tracesToken);
  if (!tracesUrl || !tracesDataset || !tracesToken) {
    return null;
  }
  return { tracesUrl, tracesDataset, tracesToken };
}
