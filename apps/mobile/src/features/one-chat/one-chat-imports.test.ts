// @effect-diagnostics nodeBuiltinImport:off - the check reads source files at test time.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const FOLDER = import.meta.dirname;

/** Old screen modules the one chat screen must never pull in. */
const FORBIDDEN = [
  "ThreadFeed",
  "ThreadComposer",
  "ThreadDetailScreen",
  "ProjectTeamCards",
  "RequestMessageCard",
  "HomeScreen",
  "CardSnooze",
  "PendingApprovalCard",
  "PendingUserInputCard",
  "WorkspaceRootScreen",
];

/** The chooser renders the classic home when the switch is off; nothing else may. */
const CHOOSER = "home-or-one-chat.tsx";

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z]+)+$/;

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bvi\.mock\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  return specifiers;
}

describe("one chat folder", () => {
  const files = readdirSync(FOLDER);

  it("never imports the old screens", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const source = readFileSync(join(FOLDER, file), "utf8");
      for (const specifier of importSpecifiers(source)) {
        const allowed = file === CHOOSER && specifier.endsWith("/WorkspaceRootScreen");
        if (!allowed && FORBIDDEN.some((forbidden) => specifier.includes(forbidden))) {
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
