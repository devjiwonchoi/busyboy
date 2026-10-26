// @effect-diagnostics nodeBuiltinImport:off - Encrypts fixtures with the same
// OSCrypt primitives the module under test decrypts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import {
  decodeChromiumKeys,
  encodeChromiumKeys,
  readChromePasswordDatabase,
  readChromePasswords,
} from "./ChromePasswords.ts";

const key = NodeCrypto.pbkdf2Sync("secret", "saltysalt", 1003, 16, "sha1");

const encryptV10 = (value: string) => {
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]);
};

const createLoginDatabase = (filename: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`create table logins (origin_url text, username_value text,
      password_value blob, blacklisted_by_user integer)`;
    yield* sql`insert into logins values
      (${"https://github.com/login"}, ${"octo"}, ${encryptV10("hunter2")}, 0),
      (${"https://never.test/"}, ${""}, ${Buffer.alloc(0)}, 1),
      (${"android://hash@com.example/"}, ${"app"}, ${encryptV10("x")}, 0),
      (${"https://broken.test/"}, ${"me"}, ${Buffer.from("v10garbage")}, 0)`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

describe("Chromium key codec", () => {
  it("round-trips the keys kept in the vault", () => {
    const decoded = decodeChromiumKeys(encodeChromiumKeys({ cbcV10: key }));
    expect(decoded.cbcV10?.equals(key)).toBe(true);
    expect(Object.keys(decoded)).toEqual(["cbcV10"]);
  });
});

describe("readChromePasswords", () => {
  it.effect("reads a copy of each database with kept keys", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      yield* createLoginDatabase(`${directory}/Login Data For Account`);

      const read = yield* readChromePasswords({
        databasePaths: [`${directory}/Login Data For Account`],
        keys: decodeChromiumKeys(encodeChromiumKeys({ cbcV10: key })),
        platform: "darwin",
      });

      expect(read.passwords).toEqual([
        { origin: "https://github.com", username: "octo", password: "hunter2" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("readChromePasswordDatabase", () => {
  it.effect("decrypts saved logins and skips never-save and non-web rows", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const snapshotPath = `${directory}/Login Data`;

      yield* createLoginDatabase(snapshotPath);

      const read = yield* readChromePasswordDatabase({
        snapshotPath,
        keys: { cbcV10: key },
        platform: "darwin",
      });

      expect(read).toEqual({
        passwords: [{ origin: "https://github.com", username: "octo", password: "hunter2" }],
        skipped: 2,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
