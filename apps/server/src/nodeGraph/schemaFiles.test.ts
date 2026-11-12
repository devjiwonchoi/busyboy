// @effect-diagnostics nodeBuiltinImport:off - compares the checked-in JSON Schema files.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { nodeContractJsonSchema, nodeStatusJsonSchema } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

/** Run with UPDATE_NODE_SCHEMAS=1 to rewrite the files after a schema change. */
const expectSchemaFile = (name: string, generated: unknown) => {
  const path = fileURLToPath(new URL(`../../../../schema/${name}`, import.meta.url));
  const text = `${JSON.stringify(generated, null, 2)}\n`;
  if (process.env.UPDATE_NODE_SCHEMAS === "1") writeFileSync(path, text);
  // Compare content, not layout, so formatting the file does not break it.
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(text));
};

describe("checked-in node graph JSON Schemas", () => {
  it("keeps schema/node.schema.json in step with the node contract", () => {
    expectSchemaFile("node.schema.json", nodeContractJsonSchema());
  });

  it("keeps schema/status.schema.json in step with the node status", () => {
    expectSchemaFile("status.schema.json", nodeStatusJsonSchema());
  });
});
