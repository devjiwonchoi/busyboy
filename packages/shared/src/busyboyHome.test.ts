// @effect-diagnostics nodeBuiltinImport:off - builds real home layouts on disk.
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  classifyLegacyDatabase,
  migrateLegacyBusyBoyHome,
  migrateLegacyElectronUserData,
  resolveBusyBoyHome,
} from "./busyboyHome.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const makeHome = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "busyboy-home-"));
  roots.push(root);
  return root;
};

const writeDatabase = (path: string, migrations: ReadonlyArray<readonly [number, string]>) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(
    "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT, created_at TEXT)",
  );
  const insert = database.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?, 'now')");
  for (const [id, name] of migrations) insert.run(id, name);
  database.close();
};

const BUSYBOY_MIGRATIONS = [
  [1, "Baseline"],
  [2, "RewriteThreadSettlementEvents"],
  [3, "RewriteThreadSnoozeEvents"],
  [4, "ProjectTeam"],
] as const;

describe("busyboyHome", () => {
  it("uses BUSYBOY_HOME when set, otherwise ~/.busyboy", () => {
    assert.equal(resolveBusyBoyHome({ homeDirectory: "/h", env: {} }), "/h/.busyboy");
    assert.equal(
      resolveBusyBoyHome({ homeDirectory: "/h", env: { BUSYBOY_HOME: " /custom " } }),
      "/custom",
    );
  });

  it("tells BusyBoy's database apart from T3 Code's by migration names", () => {
    const home = makeHome();
    const busyboy = NodePath.join(home, "a.sqlite");
    const olderBusyboy = NodePath.join(home, "b.sqlite");
    const t3code = NodePath.join(home, "c.sqlite");
    writeDatabase(busyboy, BUSYBOY_MIGRATIONS);
    writeDatabase(olderBusyboy, BUSYBOY_MIGRATIONS.slice(0, 3));
    writeDatabase(t3code, [
      [1, "Baseline"],
      [2, "AddProviderSessions"],
    ]);
    assert.equal(classifyLegacyDatabase(busyboy), "busyboy");
    assert.equal(classifyLegacyDatabase(olderBusyboy), "busyboy");
    assert.equal(classifyLegacyDatabase(t3code), "other");
    assert.equal(classifyLegacyDatabase(NodePath.join(home, "missing.sqlite")), "missing");
  });

  it("does nothing when BUSYBOY_HOME is set or ~/.busyboy already exists", () => {
    const home = makeHome();
    writeDatabase(NodePath.join(home, ".t3", "userdata", "statev2.sqlite"), BUSYBOY_MIGRATIONS);
    assert.deepEqual(
      migrateLegacyBusyBoyHome({ homeDirectory: home, env: { BUSYBOY_HOME: "/x" } }),
      { kind: "explicit-home" },
    );
    NodeFS.mkdirSync(NodePath.join(home, ".busyboy"));
    assert.deepEqual(migrateLegacyBusyBoyHome({ homeDirectory: home, env: {} }), {
      kind: "already-present",
    });
    assert.deepEqual(NodeFS.readdirSync(NodePath.join(home, ".busyboy")), []);
  });

  it("copies the Electron profile only after a home migration, without lock or cache files", () => {
    const home = makeHome();
    const appData = NodePath.join(home, "AppData");
    const legacyProfile = NodePath.join(appData, "t3code-v2");
    NodeFS.mkdirSync(NodePath.join(legacyProfile, "Local Storage"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(legacyProfile, "Cache"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(legacyProfile, "Local Storage", "leveldb"), "ls");
    NodeFS.writeFileSync(NodePath.join(legacyProfile, "Cache", "blob"), "cache");
    NodeFS.writeFileSync(NodePath.join(legacyProfile, "SingletonCookie"), "lock");
    const busyBoyHome = NodePath.join(home, ".busyboy");

    // Fresh install: no marker, so nothing is copied.
    NodeFS.mkdirSync(busyBoyHome);
    assert.equal(
      migrateLegacyElectronUserData({
        appDataDirectory: appData,
        busyBoyHome,
        isDevelopment: false,
      }),
      "skipped",
    );

    NodeFS.writeFileSync(
      NodePath.join(busyBoyHome, "migrated-from.json"),
      JSON.stringify({ stateDirs: ["userdata"] }),
    );
    assert.equal(
      migrateLegacyElectronUserData({
        appDataDirectory: appData,
        busyBoyHome,
        isDevelopment: false,
      }),
      "copied",
    );
    const profile = NodePath.join(appData, "busyboy-userdata");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(profile, "Local Storage", "leveldb"), "utf8"),
      "ls",
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(profile, "Cache")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(profile, "SingletonCookie")));
    // The legacy profile is left as it was.
    assert.isTrue(NodeFS.existsSync(NodePath.join(legacyProfile, "Cache", "blob")));
    assert.equal(
      migrateLegacyElectronUserData({
        appDataDirectory: appData,
        busyBoyHome,
        isDevelopment: false,
      }),
      "skipped",
    );
  });
});
