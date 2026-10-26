import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { readChromeHistoryDatabase } from "./ChromeHistory.ts";

const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000;
const now = Date.UTC(2026, 9, 27);
/** Chrome's microseconds since 1601, as a BigInt because it exceeds safe integers. */
const webkitTime = (ms: number) => (BigInt(ms) + BigInt(WEBKIT_EPOCH_OFFSET_MS)) * 1000n;
const day = 24 * 60 * 60 * 1000;

describe("readChromeHistoryDatabase", () => {
  it.effect("reads visible pages newer than the cutoff, converting Chrome's timestamps", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const snapshotPath = `${directory}/History`;

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table urls (id integer primary key, url text, title text,
          visit_count integer, typed_count integer, last_visit_time integer, hidden integer)`;
        yield* sql`insert into urls (url, title, visit_count, typed_count, last_visit_time, hidden)
          values
          (${"https://github.com/"}, ${"GitHub"}, ${12}, ${3}, ${webkitTime(now - day)}, ${0}),
          (${"https://old.test/"}, ${"Old"}, ${4}, ${0}, ${webkitTime(now - 60 * day)}, ${0}),
          (${"https://frame.test/"}, ${"Frame"}, ${1}, ${0}, ${webkitTime(now)}, ${1})`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })));

      const entries = yield* readChromeHistoryDatabase({ snapshotPath, since: now - 42 * day });

      expect(entries).toEqual([
        { url: "https://github.com/", title: "GitHub", visitCount: 12, lastVisit: now - day },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
