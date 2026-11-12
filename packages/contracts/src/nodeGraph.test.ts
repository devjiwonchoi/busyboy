import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  NODE_SCHEMA_URL,
  NodeContract,
  NodeStatus,
  STATUS_SCHEMA_URL,
  nodeContractJsonSchema,
  nodeStatusJsonSchema,
} from "./nodeGraph.ts";

describe("node graph JSON Schemas", () => {
  it("names each file by its published URL", () => {
    expect(nodeContractJsonSchema()).toMatchObject({ $id: NODE_SCHEMA_URL });
    expect(nodeStatusJsonSchema()).toMatchObject({ $id: STATUS_SCHEMA_URL });
  });

  it("rejects a contract whose criteria are not a list", () => {
    const decode = Schema.decodeUnknownExit(NodeContract);
    const valid = {
      id: "busyboy/x",
      title: "X",
      version: 1,
      approved: null,
      parent: null,
      purpose: null,
      criteria: [],
      dont: [],
      waitsOn: [],
      expectedFiles: [],
    };
    expect(decode(valid)._tag).toBe("Success");
    expect(decode({ ...valid, criteria: "1, 2" })._tag).toBe("Failure");
  });

  it("rejects a status with an unknown criterion status", () => {
    const decode = Schema.decodeUnknownExit(NodeStatus);
    const status = {
      state: "running",
      criteria: [{ id: "1", status: "maybe", evidence: [] }],
      unmatchedResults: [],
      reviewFindings: [],
      asks: [],
      progress: null,
      dots: { ask: false, failed: false, waiting: false },
      changes: { kind: "unavailable", reason: "no git" },
    };
    expect(decode(status)._tag).toBe("Failure");
  });
});
