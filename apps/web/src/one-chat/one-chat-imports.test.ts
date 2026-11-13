// @effect-diagnostics nodeBuiltinImport:off - the check reads source files at test time.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const FOLDER = import.meta.dirname;

/** Old screen modules the one chat screen must never pull in. */
const FORBIDDEN = [
  "ChatView",
  "ChatComposer",
  "MessagesTimeline",
  "DecisionCard",
  "PlanApproval",
  "RequestMessage",
  "CardSideChat",
  "Sidebar",
  "AppSidebarLayout",
  "ThreadRouteView",
  "components/chat/",
  "components/director/",
  "components/sidebar/",
];

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z]+)+$/;

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bvi\.mock\(\s*import\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  return specifiers;
}

describe("one chat folder", () => {
  const files = readdirSync(FOLDER);

  it("never imports the old screens", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === "one-chat-imports.test.ts") continue;
      const source = readFileSync(join(FOLDER, file), "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (FORBIDDEN.some((forbidden) => specifier.includes(forbidden))) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names every file in kebab case", () => {
    expect(files.filter((file) => !KEBAB_CASE.test(file))).toEqual([]);
  });
});
