// @effect-diagnostics nodeBuiltinImport:off - Reads the Darwin kernel version once.
/**
 * Whether new agent sessions get the `computer-use` MCP capability: the
 * setting is on, the server runs on macOS 14 or later, and a desktop app
 * passed the computer-use channel fds (the same condition as
 * `DesktopComputerUseChannel.available`).
 */
import * as NodeOs from "node:os";

/** macOS 14 is Darwin 23. */
const MIN_DARWIN_MAJOR = 23;

export const platformSupportsComputerUse = (
  platform: NodeJS.Platform = process.platform,
  release: string = NodeOs.release(),
): boolean => platform === "darwin" && Number.parseInt(release, 10) >= MIN_DARWIN_MAJOR;

export const computerUseCapabilityAvailable = (input: {
  readonly enabled: boolean;
  readonly channelAvailable: boolean;
  readonly platformSupported?: boolean;
}): boolean =>
  input.enabled &&
  input.channelAvailable &&
  (input.platformSupported ?? platformSupportsComputerUse());
