// @effect-diagnostics nodeBuiltinImport:off - reads fixtures and drives a throwaway git repository.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { actualChanges } from "./actualChanges.ts";
import { buildStatus, compareChanges, evidenceGrade } from "./compute.ts";
import { parseRecord } from "./parseJwn.ts";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${path}`, import.meta.url)), "utf8");

const NO_CHANGES = { kind: "unavailable", reason: "test" } as const;

/**
 * align-plan's 10 criteria with a numbered VERIFY: 6 pass with a linked artifact, criterion 7
 * fails, criterion 8 passes on words alone (not counted), 9–10 have no row.
 */
const SYNTHETIC_VERIFY = [
  "# Verify",
  "",
  "| Criterion | Result | Evidence |",
  "| --- | --- | --- |",
  "| 1 · Delete skills/plan | pass | [ls output](.jwn/align-plan/logs/ls.txt) |",
  "| 2 | pass | https://github.com/devjiwonchoi/skills/actions/runs/1 |",
  "| 3 | pass | [grep](.jwn/align-plan/logs/grep-ledger.txt) |",
  "| 4 | pass | [review notes](.jwn/align-plan/REVIEW.md) |",
  "| 5 | pass | [walkthrough](.jwn/align-plan/logs/walkthrough.txt) |",
  "| 6 | pass | [grep log](.jwn/align-plan/logs/grep.txt) |",
  "| 7 | fail | two broken links |",
  "| 8 | pass | looked fine |",
  "| Extra smoke check | pass | ran it |",
].join("\n");

describe("progress, criterion results and evidence grades", () => {
  it("counts proven criteria over the contract's criteria", () => {
    const parsed = parseRecord("skills/align-plan", {
      "ALIGN.md": read("skills/align-plan/ALIGN.md"),
      "STATUS.md": read("skills/align-plan/STATUS.md"),
      "VERIFY.md": SYNTHETIC_VERIFY,
    });
    const status = buildStatus({ parsed, asks: [], waiting: false, changes: NO_CHANGES });
    expect(status.progress).toEqual({ proven: 6, total: 10 });
    expect(status.criteria.map((result) => [result.id, result.status])).toEqual([
      ["1", "proven"],
      ["2", "proven"],
      ["3", "proven"],
      ["4", "proven"],
      ["5", "proven"],
      ["6", "proven"],
      ["7", "failed"],
      ["8", "proven"],
      ["9", "pending"],
      ["10", "pending"],
    ]);
    expect(status.criteria[1]?.evidence[0]).toMatchObject({
      ref: "https://github.com/devjiwonchoi/skills/actions/runs/1",
      grade: "capture",
    });
    expect(status.criteria[5]?.evidence[0]).toMatchObject({
      ref: ".jwn/align-plan/logs/grep.txt",
      grade: "capture",
    });
    expect(status.criteria[7]?.evidence[0]).toMatchObject({ ref: null, grade: "claim" });
    expect(status.unmatchedResults).toEqual([
      {
        label: "Extra smoke check",
        status: "proven",
        evidence: [expect.objectContaining({ grade: "claim" })],
      },
    ]);
    expect(status.dots).toEqual({ ask: false, failed: true, waiting: false });
  });

  it("leaves progress empty without a contract and keeps remove-settle's rows unmatched", () => {
    const parsed = parseRecord("busyboy/remove-settle", {
      "STATUS.md": read("busyboy/remove-settle/STATUS.md"),
      "VERIFY.md": read("busyboy/remove-settle/VERIFY.md"),
    });
    const status = buildStatus({ parsed, asks: [], waiting: false, changes: NO_CHANGES });
    expect(status.progress).toBeNull();
    expect(status.criteria).toEqual([]);
    expect(status.unmatchedResults).toHaveLength(6);
    expect(
      status.unmatchedResults.every(
        (result) => result.status === "proven" && result.evidence[0]?.grade === "claim",
      ),
    ).toBe(true);
  });

  it("grades ci and reviewer evidence as an independent rerun", () => {
    expect(evidenceGrade("ci", null)).toBe("rerun");
    expect(evidenceGrade("reviewer", null)).toBe("rerun");
    expect(evidenceGrade("worker", "https://example.com/log")).toBe("capture");
    expect(evidenceGrade("worker", null)).toBe("claim");
    expect(evidenceGrade(null, null)).toBe("claim");
  });

  it("counts an auto criterion only with a rerun and an evidence criterion only with a capture", () => {
    const parsed = parseRecord("x/checks", {
      "ALIGN.md": [
        "# ALIGN: Checks",
        "# Success criteria",
        "## 1 · Tests pass",
        "- Check: auto",
        "## 2 · Recording shows it",
        "- Check: evidence",
        "## 3 · Same as 1 but rerun",
        "- Check: auto",
      ].join("\n"),
      "VERIFY.md": [
        "| Criterion | Result | Evidence | By |",
        "| --- | --- | --- | --- |",
        "| 1 | pass | ran locally | worker |",
        "| 2 | pass | no link | worker |",
        "| 3 | pass | https://ci.example/run/9 | ci |",
      ].join("\n"),
    });
    const status = buildStatus({ parsed, asks: [], waiting: false, changes: NO_CHANGES });
    expect(status.criteria.map((result) => result.status)).toEqual(["proven", "proven", "proven"]);
    expect(status.criteria[2]?.evidence[0]?.grade).toBe("rerun");
    expect(status.progress).toEqual({ proven: 1, total: 3 });
  });
});

describe("conservative grading", () => {
  it("lets the latest verification round decide a criterion", () => {
    const parsed = parseRecord("x/rounds", {
      "ALIGN.md": "# ALIGN: Rounds\n# Success criteria\n## 1 · Works\n",
      "VERIFY.md": [
        "## 2026-11-10: FAILED",
        "1. Works. Evidence: [log](logs/1.txt)",
        "## 2026-11-11: PASSED",
        "1. Works. Evidence: [log](logs/2.txt)",
      ].join("\n"),
    });
    const status = buildStatus({ parsed, asks: [], waiting: false, changes: NO_CHANGES });
    expect(status.criteria[0]?.status).toBe("proven");
    expect(status.dots.failed).toBe(false);
    expect(status.progress).toEqual({ proven: 1, total: 1 });
  });

  it("grades only the latest row, so an older rerun cannot back a newer claim", () => {
    const parsed = parseRecord("x/latest-grade", {
      "ALIGN.md": "# ALIGN: Latest\n# Success criteria\n## 1 · Tests\n- Check: auto\n",
      "VERIFY.md": [
        "| Criterion | Result | Evidence | By |",
        "| --- | --- | --- | --- |",
        "| 1 | fail | https://ci.example/run/1 | ci |",
        "| 1 | pass | fixed it | worker |",
      ].join("\n"),
    });
    const status = buildStatus({ parsed, asks: [], waiting: false, changes: NO_CHANGES });
    expect(status.criteria[0]?.status).toBe("proven");
    expect(status.progress).toEqual({ proven: 0, total: 1 });
  });

  it("reads who produced evidence only from a By column or a by: marker", () => {
    const parsed = parseRecord("x/by", {
      "ALIGN.md":
        "# ALIGN: By\n# Success criteria\n## 1 · Tests\n- Check: auto\n## 2 · Lint\n- Check: auto\n",
      "VERIFY.md": [
        "| Criterion | Result | Evidence |",
        "| --- | --- | --- |",
        "| 1 | pass | CI looked fine locally |",
        "| 2 | pass | https://ci.example/run/3 by: ci |",
      ].join("\n"),
    });
    const status = buildStatus({ parsed, asks: [], waiting: false, changes: NO_CHANGES });
    expect(status.criteria.map((result) => result.evidence[0]?.grade)).toEqual(["claim", "rerun"]);
    expect(status.progress).toEqual({ proven: 1, total: 2 });
  });

  it("counts a human criterion only when a person or reviewer signs it", () => {
    const parsed = parseRecord("x/human", {
      "ALIGN.md":
        "# ALIGN: Human\n# Success criteria\n## 1 · Looks right\n- Check: human\n## 2 · Reads well\n- Check: human\n",
      "VERIFY.md": [
        "| Criterion | Result | Evidence | By |",
        "| --- | --- | --- | --- |",
        "| 1 | pass | https://example.com/shot.png | worker |",
        "| 2 | pass | approved in chat | human |",
      ].join("\n"),
    });
    const status = buildStatus({ parsed, asks: [], waiting: false, changes: NO_CHANGES });
    expect(status.progress).toEqual({ proven: 1, total: 2 });
  });
});

describe("toast dots", () => {
  const parsed = parseRecord("x/dots", {
    "ALIGN.md": "# ALIGN: Dots\n# Success criteria\n## 1 · Works\n",
    "STATUS.md": "- State: running\n",
  });

  it("turns blue for an unanswered card and yellow while a dependency waits", () => {
    const status = buildStatus({
      parsed,
      asks: [
        {
          id: "request-1",
          threadId: ThreadId.make("thread-1"),
          kind: "question",
          question: "Ship it?",
          sub: null,
          options: [],
          answer: null,
        },
      ],
      waiting: true,
      changes: NO_CHANGES,
    });
    expect(status.dots).toEqual({ ask: true, failed: false, waiting: true });
    expect(status.state).toBe("asking");
  });

  it("stays clear with nothing to answer, fail or wait for", () => {
    expect(buildStatus({ parsed, asks: [], waiting: false, changes: NO_CHANGES }).dots).toEqual({
      ask: false,
      failed: false,
      waiting: false,
    });
  });
});

describe("expected file tree against actual changes", () => {
  it("lists what was expected but untouched and what changed unexpectedly", () => {
    expect(
      compareChanges(
        [
          { path: "skills/align/", change: "new" },
          { path: "README.md", change: "modified" },
          { path: "hooks/hooks.json", change: "modified" },
        ],
        ["skills/align/SKILL.md", "README.md", "skills/ship/SKILL.md"],
        "main@abc",
      ),
    ).toEqual({
      kind: "compared",
      base: "main@abc",
      expectedOnly: ["hooks/hooks.json"],
      actualOnly: ["skills/ship/SKILL.md"],
      both: ["skills/align/SKILL.md", "README.md"],
    });
  });

  let repo: string | null = null;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = null;
  });

  it("reads committed, uncommitted and untracked changes since the default branch", async () => {
    repo = mkdtempSync(join(tmpdir(), "node-graph-git-"));
    const git = (...args: Array<string>) =>
      execFileSync("git", args, {
        cwd: repo!,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git("add", ".");
    git("commit", "-qm", "init");
    git("checkout", "-qb", "feature");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/a.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-qm", "add a");
    writeFileSync(join(repo, "README.md"), "changed\n");
    writeFileSync(join(repo, "notes.txt"), "untracked\n");

    const changes = await actualChanges(repo, [
      { path: "src/a.ts", change: "new" },
      { path: "src/b.ts", change: "new" },
    ]);
    expect(changes).toMatchObject({
      kind: "compared",
      expectedOnly: ["src/b.ts"],
      actualOnly: ["README.md", "notes.txt"],
      both: ["src/a.ts"],
    });
  });

  it("says the comparison is unavailable outside git", async () => {
    repo = mkdtempSync(join(tmpdir(), "node-graph-plain-"));
    expect(await actualChanges(repo, [{ path: "a.ts", change: "new" }])).toMatchObject({
      kind: "unavailable",
    });
  });
});
