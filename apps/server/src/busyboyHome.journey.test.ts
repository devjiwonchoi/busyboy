// @effect-diagnostics nodeBuiltinImport:off - drives the real CLI against a temp HOME.
// Journey: someone installs this BusyBoy next to T3 Code, or upgrades a BusyBoy
// that still kept its data in T3 Code's `~/.t3`. BusyBoy must move into its own
// `~/.busyboy` and leave every T3 Code file exactly as it was.
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUSYBOY_MIGRATIONS } from "@t3tools/shared/busyboyHome";

import { migrationManifest } from "./persistence/Migrations.ts";

const BIN = NodePath.resolve(import.meta.dirname, "bin.ts");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const makeHome = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "busyboy-journey-"));
  roots.push(root);
  return root;
};

const runCli = (home: string, args: ReadonlyArray<string>) => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("BUSYBOY_") || key.startsWith("T3CODE_")) delete env[key];
  }
  const result = NodeChildProcess.spawnSync(process.execPath, [BIN, ...args], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);
  return result.stdout;
};

const listSessions = (home: string, extra: ReadonlyArray<string> = []) =>
  JSON.parse(runCli(home, ["auth", "session", "list", "--json", ...extra])) as Array<{
    sessionId: string;
  }>;

/** Path -> sha256 of every file under a directory. */
const snapshot = (root: string) => {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        files.set(
          NodePath.relative(root, path),
          NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex"),
        );
    }
  };
  walk(root);
  return files;
};

const migrationNames = (databasePath: string) => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare("SELECT name FROM effect_sql_migrations ORDER BY migration_id")
      .all()
      .map((row) => String(row.name));
  } finally {
    database.close();
  }
};

describe("BusyBoy home separation", () => {
  it("knows every server migration, so the ~/.t3 check recognises BusyBoy's database", () => {
    assert.deepEqual(
      BUSYBOY_MIGRATIONS.map(([id, name]) => [id, name]),
      migrationManifest.map(([id, name]) => [id, name]),
    );
  });

  it("starts clean in ~/.busyboy next to T3 Code and leaves T3 Code's files untouched", () => {
    const home = makeHome();
    const t3 = NodePath.join(home, ".t3");
    // T3 Code's own database: its migration history differs from BusyBoy's.
    NodeFS.mkdirSync(NodePath.join(t3, "userdata"), { recursive: true });
    const t3Database = new DatabaseSync(NodePath.join(t3, "userdata", "statev2.sqlite"));
    t3Database.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT, created_at TEXT);" +
        "INSERT INTO effect_sql_migrations VALUES (1, 'Baseline', 'x'), (2, 'T3CodeOnlyMigration', 'x');" +
        "CREATE TABLE t3_threads (id TEXT); INSERT INTO t3_threads VALUES ('t3-thread');",
    );
    t3Database.close();
    NodeFS.writeFileSync(NodePath.join(t3, "userdata", "settings.json"), '{"t3":true}\n');
    NodeFS.mkdirSync(NodePath.join(t3, "worktrees", "repo", "wt"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(t3, "worktrees", "repo", "wt", "file.txt"), "t3\n");
    const before = snapshot(t3);

    assert.deepEqual(listSessions(home), []);

    const busyboy = NodePath.join(home, ".busyboy");
    assert.isTrue(NodeFS.existsSync(NodePath.join(busyboy, "userdata", "statev2.sqlite")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(busyboy, "migrated-from.json")));
    // BusyBoy ran its own migrations, including the project team (PM) one.
    assert.deepEqual(
      migrationNames(NodePath.join(busyboy, "userdata", "statev2.sqlite")),
      migrationManifest.map(([, name]) => name),
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(busyboy, "userdata", "settings.json")));
    assert.deepEqual(snapshot(t3), before);
  });

  it("copies an older BusyBoy's data out of ~/.t3 once and never changes ~/.t3", () => {
    const home = makeHome();
    const t3 = NodePath.join(home, ".t3");
    // An older BusyBoy build that kept its data in T3 Code's home.
    const [issued] = [
      JSON.parse(runCli(home, ["auth", "session", "issue", "--json", "--base-dir", t3])) as {
        sessionId: string;
      },
    ];
    NodeFS.writeFileSync(NodePath.join(t3, "userdata", "settings.json"), '{"mine":true}\n');
    NodeFS.mkdirSync(NodePath.join(t3, "worktrees", "repo", "wt"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(t3, "worktrees", "repo", "wt", "file.txt"), "wt\n");
    NodeFS.rmSync(NodePath.join(t3, "userdata", "server-runtime.json"), { force: true });
    const before = snapshot(t3);

    // The session (and the secret that signs it) came along with the data.
    assert.deepEqual(
      listSessions(home).map((session) => session.sessionId),
      [issued!.sessionId],
    );

    const busyboy = NodePath.join(home, ".busyboy");
    // Settings came along, and ~/.t3/worktrees stays a managed worktrees folder.
    const migratedSettings = NodeFS.readFileSync(
      NodePath.join(busyboy, "userdata", "settings.json"),
      "utf8",
    );
    assert.deepEqual(JSON.parse(migratedSettings), {
      mine: true,
      previousWorktreesDirectories: [NodePath.join(t3, "worktrees")],
    });
    const marker = JSON.parse(
      NodeFS.readFileSync(NodePath.join(busyboy, "migrated-from.json"), "utf8"),
    ) as { source: string; stateDirs: string[] };
    assert.equal(marker.source, t3);
    assert.deepEqual(marker.stateDirs, ["userdata"]);
    // Worktrees stay where git registered them; new ones go to ~/.busyboy.
    assert.isFalse(NodeFS.existsSync(NodePath.join(busyboy, "worktrees", "repo")));
    assert.deepEqual(snapshot(t3), before);

    // Later launches use ~/.busyboy as is; nothing is copied again.
    NodeFS.writeFileSync(NodePath.join(t3, "userdata", "settings.json"), '{"changed":true}\n');
    listSessions(home);
    assert.equal(
      NodeFS.readFileSync(NodePath.join(busyboy, "userdata", "settings.json"), "utf8"),
      migratedSettings,
    );
  });
});
