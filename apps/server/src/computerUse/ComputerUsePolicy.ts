/**
 * Apps agents may never read or operate through computer use, whatever the
 * user approves. Approval is keyed by bundle ID, which the driver resolves
 * from the running app, so an agent cannot reach these by naming them
 * differently.
 */

/** Exact bundle IDs, compared case-insensitively. */
const FORBIDDEN_BUNDLE_IDS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    // Busyboy itself: an agent driving it could approve its own requests.
    "dev.jiwon.busyboy": "Busyboy",
    // Credential stores.
    "com.apple.keychainaccess": "Keychain Access",
    "com.apple.passwords": "Passwords",
    "com.1password.1password": "1Password",
    "com.agilebits.onepassword7": "1Password",
    "com.bitwarden.desktop": "Bitwarden",
    "com.lastpass.lastpass": "LastPass",
    "com.dashlane.dashlanephonefinal": "Dashlane",
    "in.sinew.enpass-desktop": "Enpass",
    "com.keepassxc.keepassxc": "KeePassXC",
    "com.proton.pass": "Proton Pass",
    // Terminals: typing into one runs commands outside every approval.
    "com.apple.terminal": "Terminal",
    "com.googlecode.iterm2": "iTerm",
    "dev.warp.warp-stable": "Warp",
    "net.kovidgoyal.kitty": "kitty",
    "com.mitchellh.ghostty": "Ghostty",
    "org.alacritty": "Alacritty",
    "io.alacritty": "Alacritty",
    "com.github.wez.wezterm": "WezTerm",
    "co.zeit.hyper": "Hyper",
  }).map(([bundleId, name]) => [bundleId.toLowerCase(), name]),
);

/** Prefixes covering every variant of an app, such as Busyboy's dev builds. */
const FORBIDDEN_BUNDLE_ID_PREFIXES: ReadonlyArray<readonly [prefix: string, name: string]> = [
  ["dev.jiwon.busyboy.", "Busyboy"],
];

export type ComputerUseAppPolicy =
  | { readonly kind: "allowed" }
  | { readonly kind: "forbidden"; readonly reason: string }
  | { readonly kind: "unidentified" };

export function computerUseAppPolicy(bundleId: string | undefined): ComputerUseAppPolicy {
  // Without a bundle ID there is nothing to approve or forbid reliably.
  if (bundleId === undefined || bundleId.trim() === "") return { kind: "unidentified" };
  const key = bundleId.trim().toLowerCase();
  const exact = FORBIDDEN_BUNDLE_IDS.get(key);
  if (exact !== undefined) return { kind: "forbidden", reason: forbiddenReason(exact) };
  for (const [prefix, name] of FORBIDDEN_BUNDLE_ID_PREFIXES) {
    if (key.startsWith(prefix)) return { kind: "forbidden", reason: forbiddenReason(name) };
  }
  return { kind: "allowed" };
}

function forbiddenReason(name: string): string {
  return `Computer use cannot be used with ${name}. Ask the user to do this step themselves.`;
}
