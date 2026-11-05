// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Runs synchronously before any Effect runtime exists.
// BusyBoy keeps all of its state in its own home so it never shares a database,
// worktrees or settings with T3 Code. Older BusyBoy builds stored everything in
// T3 Code's `~/.t3`; this module copies that data into `~/.busyboy` once.
//
// Safety rules for the one-time migration:
// - `~/.t3` is only ever read. Nothing there is written, moved or deleted.
// - A state dir is copied only when its database was written by BusyBoy alone
//   (every applied migration is one of BusyBoy's own). A T3 Code database is
//   left behind and BusyBoy starts clean.
// - Data is assembled in a staging dir and renamed into place, so a crash
//   never leaves a half-migrated `~/.busyboy` behind.
// - Worktrees and scratch folders stay where they are: git registers worktrees
//   by absolute path, and existing threads keep pointing at them.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

export const BUSYBOY_HOME_ENV = "BUSYBOY_HOME";
export const BUSYBOY_HOME_DIRNAME = ".busyboy";
export const LEGACY_T3_HOME_DIRNAME = ".t3";
export const MIGRATION_MARKER_FILENAME = "migrated-from.json";

/** Electron userData dir names. T3 Code keeps using `t3code-v2` / `t3code-dev`. */
export const BUSYBOY_ELECTRON_USER_DATA_NAMES = {
  production: "busyboy-userdata",
  development: "busyboy-userdata-dev",
} as const;
const LEGACY_ELECTRON_USER_DATA_NAMES = {
  production: "t3code-v2",
  development: "t3code-dev",
} as const;

/**
 * BusyBoy's database migrations, mirroring the server's migration manifest
 * (a server test keeps the two equal). A legacy database counts as BusyBoy's
 * only if every migration it applied is in this list; T3 Code's databases
 * have migrations BusyBoy never had.
 */
export const BUSYBOY_MIGRATIONS: ReadonlyArray<readonly [number, string]> = [
  [1, "Baseline"],
  [2, "RewriteThreadSettlementEvents"],
  [3, "RewriteThreadSnoozeEvents"],
  [4, "ProjectTeam"],
  [5, "ProjectAttentionSuperseded"],
];

const STATE_DIR_NAMES = ["userdata", "dev"] as const;
const DATABASE_FILENAME = "statev2.sqlite";

// Runtime, lock and log files belong to the old process and must not be copied.
const SKIPPED_STATE_ENTRIES = new Set([
  "server-runtime.json",
  "server-owner.sqlite",
  "server-owner.sqlite-journal",
  "server-owner.sqlite-wal",
  "server-owner.sqlite-shm",
  "logs",
  "pending-update",
]);
const SKIPPED_PROFILE_ENTRIES = new Set([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "RunningChromeVersion",
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "ShaderCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "Crashpad",
  "logs",
]);

export function resolveBusyBoyHome(input: {
  readonly homeDirectory: string;
  readonly env: NodeJS.ProcessEnv;
}): string {
  const configured = input.env[BUSYBOY_HOME_ENV]?.trim();
  return configured ? configured : NodePath.join(input.homeDirectory, BUSYBOY_HOME_DIRNAME);
}

export type LegacyDatabaseOwner = "busyboy" | "other" | "missing";

/** Decide who wrote a legacy `statev2.sqlite`, from its migration history only. */
export function classifyLegacyDatabase(databasePath: string): LegacyDatabaseOwner {
  if (!NodeFS.existsSync(databasePath)) return "missing";
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    if (rows.length === 0) return "other";
    const known = new Map(BUSYBOY_MIGRATIONS);
    const allBusyBoy = rows.every(
      (row) => known.get(Number(row.migration_id)) === String(row.name),
    );
    return allBusyBoy ? "busyboy" : "other";
  } catch {
    return "other";
  } finally {
    database?.close();
  }
}

export type LegacyHomeMigrationResult =
  | { readonly kind: "explicit-home" }
  | { readonly kind: "already-present" }
  | { readonly kind: "no-legacy-data" }
  | { readonly kind: "legacy-not-busyboy" }
  | { readonly kind: "migrated"; readonly stateDirs: ReadonlyArray<string> };

const copyTree = (source: string, destination: string, skipped: ReadonlySet<string>) => {
  NodeFS.cpSync(source, destination, {
    recursive: true,
    errorOnExist: false,
    force: false,
    preserveTimestamps: true,
    // Sockets and other special files can't be copied and hold no data.
    filter: (entry) => {
      if (skipped.has(NodePath.basename(entry))) return false;
      try {
        const stat = NodeFS.lstatSync(entry);
        return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
      } catch {
        return false;
      }
    },
  });
};

/**
 * Copy a legacy database (and its WAL) into `destinationDir` and check the copy.
 * The original is never opened: even a read-only SQLite connection creates
 * `-wal`/`-shm` files next to a WAL database. Returns false when there is none.
 */
const copyLegacyDatabase = (sourceDir: string, destinationDir: string): boolean => {
  const source = NodePath.join(sourceDir, DATABASE_FILENAME);
  if (!NodeFS.existsSync(source)) return false;
  const destination = NodePath.join(destinationDir, DATABASE_FILENAME);
  NodeFS.mkdirSync(destinationDir, { recursive: true });
  // A copy taken while another process writes can be torn, so verify and retry.
  for (let attempt = 1; ; attempt++) {
    for (const suffix of ["", "-wal"]) {
      NodeFS.rmSync(`${destination}${suffix}`, { force: true });
      if (NodeFS.existsSync(`${source}${suffix}`)) {
        NodeFS.copyFileSync(
          `${source}${suffix}`,
          `${destination}${suffix}`,
          NodeFS.constants.COPYFILE_FICLONE,
        );
      }
    }
    NodeFS.rmSync(`${destination}-shm`, { force: true });
    const database = new DatabaseSync(destination);
    try {
      const [check] = database.prepare("PRAGMA quick_check").all();
      if (check && Object.values(check)[0] === "ok") {
        // Fold the WAL into the copy so it stands on its own.
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        return true;
      }
    } catch (error) {
      if (attempt >= 3) throw error;
    } finally {
      database.close();
    }
    if (attempt >= 3) throw new Error(`The copy of ${source} failed its integrity check.`);
  }
};

/**
 * Existing threads keep their worktrees in `~/.t3/worktrees`. Listing that
 * folder as a previous worktrees location keeps them managed: they are still
 * cleaned up when a task finishes and recreated if they go missing.
 */
const keepLegacyWorktreesManaged = (stateDir: string, legacyHome: string) => {
  const settingsPath = NodePath.join(stateDir, "settings.json");
  const settings: Record<string, unknown> = NodeFS.existsSync(settingsPath)
    ? (JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  // A custom worktrees folder is shared by both homes, so nothing moved.
  if (typeof settings.worktreesDirectory === "string" && settings.worktreesDirectory.trim()) {
    return;
  }
  const previous = Array.isArray(settings.previousWorktreesDirectories)
    ? settings.previousWorktreesDirectories.map(String)
    : [];
  const legacyWorktrees = NodePath.join(legacyHome, "worktrees");
  if (previous.includes(legacyWorktrees)) return;
  settings.previousWorktreesDirectories = [...previous, legacyWorktrees];
  NodeFS.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
};

/**
 * Copy BusyBoy's data out of T3 Code's `~/.t3` into `~/.busyboy`, once.
 * Runs before anything creates `~/.busyboy`. Throws if copying fails, so the
 * app never starts empty over data it should have migrated.
 */
export function migrateLegacyBusyBoyHome(input: {
  readonly homeDirectory: string;
  readonly env: NodeJS.ProcessEnv;
}): LegacyHomeMigrationResult {
  if (input.env[BUSYBOY_HOME_ENV]?.trim()) return { kind: "explicit-home" };
  const target = NodePath.join(input.homeDirectory, BUSYBOY_HOME_DIRNAME);
  if (NodeFS.existsSync(target)) return { kind: "already-present" };
  const legacyHome = NodePath.join(input.homeDirectory, LEGACY_T3_HOME_DIRNAME);
  if (!STATE_DIR_NAMES.some((name) => NodeFS.existsSync(NodePath.join(legacyHome, name)))) {
    return { kind: "no-legacy-data" };
  }

  const staging = `${target}.migrating-${process.pid}-${Date.now()}`;
  try {
    NodeFS.mkdirSync(staging, { recursive: true });
    const busyBoyDirs: string[] = [];
    let sawOtherDatabase = false;
    for (const name of STATE_DIR_NAMES) {
      const destinationDir = NodePath.join(staging, name);
      if (!copyLegacyDatabase(NodePath.join(legacyHome, name), destinationDir)) continue;
      if (classifyLegacyDatabase(NodePath.join(destinationDir, DATABASE_FILENAME)) === "busyboy") {
        busyBoyDirs.push(name);
      } else {
        // T3 Code's database: drop the copy, BusyBoy starts clean.
        sawOtherDatabase = true;
        NodeFS.rmSync(destinationDir, { recursive: true, force: true });
      }
    }
    if (busyBoyDirs.length === 0) {
      NodeFS.rmSync(staging, { recursive: true, force: true });
      return sawOtherDatabase ? { kind: "legacy-not-busyboy" } : { kind: "no-legacy-data" };
    }
    for (const name of busyBoyDirs) {
      const sourceDir = NodePath.join(legacyHome, name);
      const destinationDir = NodePath.join(staging, name);
      for (const entry of NodeFS.readdirSync(sourceDir)) {
        if (entry.startsWith(DATABASE_FILENAME) || SKIPPED_STATE_ENTRIES.has(entry)) continue;
        copyTree(
          NodePath.join(sourceDir, entry),
          NodePath.join(destinationDir, entry),
          SKIPPED_PROFILE_ENTRIES,
        );
      }
    }
    for (const name of busyBoyDirs) {
      keepLegacyWorktreesManaged(NodePath.join(staging, name), legacyHome);
    }
    NodeFS.writeFileSync(
      NodePath.join(staging, MIGRATION_MARKER_FILENAME),
      `${JSON.stringify(
        {
          source: legacyHome,
          stateDirs: busyBoyDirs,
          migratedAt: new Date().toISOString(),
          note: "Copied from T3 Code's home. The original is untouched. Existing worktrees stay in the old location.",
        },
        null,
        2,
      )}\n`,
    );
    try {
      NodeFS.renameSync(staging, target);
    } catch (error) {
      // Another BusyBoy process finished the same migration first.
      if (NodeFS.existsSync(target)) {
        NodeFS.rmSync(staging, { recursive: true, force: true });
        return { kind: "already-present" };
      }
      throw error;
    }
    return { kind: "migrated", stateDirs: busyBoyDirs };
  } catch (error) {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `BusyBoy could not copy its data from ${legacyHome} to ${target}. ${legacyHome} was not changed.`,
      { cause: error },
    );
  }
}

/**
 * Copy the Electron profile (local storage, preview sign-ins) that older
 * BusyBoy builds kept under T3 Code's userData name. Only runs after a home
 * migration, and only when BusyBoy has no profile of its own yet.
 */
export function migrateLegacyElectronUserData(input: {
  readonly appDataDirectory: string;
  readonly busyBoyHome: string;
  readonly isDevelopment: boolean;
}): "copied" | "skipped" {
  const variant = input.isDevelopment ? "development" : "production";
  const destination = NodePath.join(
    input.appDataDirectory,
    BUSYBOY_ELECTRON_USER_DATA_NAMES[variant],
  );
  if (NodeFS.existsSync(destination)) return "skipped";
  const markerPath = NodePath.join(input.busyBoyHome, MIGRATION_MARKER_FILENAME);
  if (!NodeFS.existsSync(markerPath)) return "skipped";
  let stateDirs: ReadonlyArray<string> = [];
  try {
    const marker = JSON.parse(NodeFS.readFileSync(markerPath, "utf8")) as { stateDirs?: unknown };
    stateDirs = Array.isArray(marker.stateDirs) ? marker.stateDirs.map(String) : [];
  } catch {
    return "skipped";
  }
  if (!stateDirs.includes(input.isDevelopment ? "dev" : "userdata")) return "skipped";
  const source = NodePath.join(input.appDataDirectory, LEGACY_ELECTRON_USER_DATA_NAMES[variant]);
  if (!NodeFS.existsSync(source)) return "skipped";
  const staging = `${destination}.migrating-${process.pid}-${Date.now()}`;
  try {
    copyTree(source, staging, SKIPPED_PROFILE_ENTRIES);
    NodeFS.renameSync(staging, destination);
    return "copied";
  } catch {
    // The profile only holds conveniences; start with a fresh one instead.
    NodeFS.rmSync(staging, { recursive: true, force: true });
    return "skipped";
  }
}
