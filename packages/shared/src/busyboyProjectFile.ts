import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { BusyboyProjectFile, BUSYBOY_PROJECT_FILE_SCHEMA_URL } from "@busyboy/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const BusyboyProjectFileFromJson = fromLenientJson(BusyboyProjectFile);

const decodeBusyboyProjectFile = Schema.decodeExit(BusyboyProjectFileFromJson);

export function parseBusyboyProjectFile(contents: string): BusyboyProjectFile | null {
  const decoded = decodeBusyboyProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildBusyboyProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(BusyboyProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: BUSYBOY_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
