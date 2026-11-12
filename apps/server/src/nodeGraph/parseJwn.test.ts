// @effect-diagnostics nodeBuiltinImport:off - reads the checked-in record fixtures.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NodeContract, NodeStatus } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { buildStatus } from "./compute.ts";
import { parseRecord, RECORD_FILES, type RecordFiles } from "./parseJwn.ts";

const fixture = (path: string): RecordFiles => {
  const files: Record<string, string> = {};
  for (const name of RECORD_FILES) {
    try {
      files[name] = readFileSync(
        fileURLToPath(new URL(`./__fixtures__/${path}/${name}`, import.meta.url)),
        "utf8",
      );
    } catch {
      // Records hold only the documents their stages needed.
    }
  }
  return files;
};

/** The real records: two with a contract (ALIGN.md), three from before ALIGN.md existed. */
const REAL_RECORDS = {
  "busyboy/clean-room": fixture("busyboy/clean-room"),
  "skills/align-plan": fixture("skills/align-plan"),
  "busyboy/computer-use": fixture("busyboy/computer-use"),
  "busyboy/remove-settle": fixture("busyboy/remove-settle"),
  "busyboy/password-standin": fixture("busyboy/password-standin"),
} as const;

const parse = (id: keyof typeof REAL_RECORDS) => parseRecord(id, REAL_RECORDS[id]);

describe("parseRecord on real records with a contract", () => {
  it("reads the clean-room contract as written", () => {
    const { contract, state, issues } = parse("busyboy/clean-room");
    expect(issues).toEqual([]);
    expect(state).toBe("running");
    expect(contract).toMatchObject({
      id: "busyboy/clean-room",
      title: "Computer Use와 내장 브라우저를 클린룸 방식으로 BusyBoy에 도입",
      version: 2,
      approved: { by: "user", on: "2026-11-04" },
      purpose: null,
      parent: null,
      dont: [],
      waitsOn: [],
    });
    expect(contract?.criteria.map((criterion) => criterion.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index + 1)),
    );
    expect(contract?.criteria[0]).toEqual({
      id: "1",
      text: "사양서와 모든 PR diff에 OpenAI 코드·문구·내부 식별자가 없게 하기",
      check: null,
      how: "오염 검사 스크립트가 사양서, 핸드오프 답변, 각 PR diff에서 0건을 보고함",
    });
    expect(contract?.criteria[19]?.text).toBe("블랙박스 비교로 완성도 확인");
    expect(contract?.expectedFiles).toHaveLength(46);
    expect(contract?.expectedFiles[4]).toEqual({
      path: "native/computer-use/Cargo.toml",
      change: "new",
    });
  });

  it("reads the skills align-plan contract and skips the example heading in a code block", () => {
    const { contract, state, issues } = parse("skills/align-plan");
    expect(issues).toEqual([]);
    expect(state).toBe("done");
    expect(contract).toMatchObject({
      title: "Replace plan with align",
      version: null,
      approved: { by: "the user", on: "2026-11-03" },
    });
    expect(contract?.criteria.map((criterion) => criterion.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
    ]);
    expect(contract?.criteria[5]?.text).toBe(
      "Leave zero hits for `skills/plan`, `PLAN.md`, or Plan-skill links",
    );
    expect(contract?.criteria[0]?.how).toBe("`ls` and a frontmatter check.");
    expect(contract?.expectedFiles).toEqual(
      expect.arrayContaining([
        { path: "skills/align/", change: "new" },
        { path: "skills/align/SKILL.md", change: null },
        { path: "skills/align/references/template.md", change: null },
        { path: "skills/plan/", change: "deleted" },
        { path: "skills/iterate/iterate/SKILL.md", change: "modified" },
        { path: "README.md", change: "modified" },
      ]),
    );
  });

  it("reads the new template's intention, don'ts, parent and waits-on lines", () => {
    const { contract, issues } = parseRecord("busyboy/mobile-notify", {
      "ALIGN.md": [
        "# ALIGN: 모바일 알림",
        "",
        "Version: 2 · Status: approved by user on 2026-11-12",
        "",
        "# Goal",
        "",
        "Intention: 답할 카드를 폰에서 놓치지 않게",
        "Parent: skill-migration",
        "Waits on: busyboy/cards-ui criterion 2, skills/align-plan criterion 5",
        "",
        "# Don'ts",
        "",
        "- Out of scope: 새 푸시 서비스 추가",
        "- Must not happen: 잠금화면에 카드 내용 노출",
        "- Out of scope: none",
        "",
        "# Success criteria",
        "",
        "## 1 · 답할 카드가 생기면 1분 안에 폰 알림",
        "- Check: evidence",
        "- Proven by: 기기 녹화",
      ].join("\n"),
    });
    expect(issues).toEqual([]);
    expect(contract).toMatchObject({
      purpose: "답할 카드를 폰에서 놓치지 않게",
      parent: "skill-migration",
      dont: ["Out of scope: 새 푸시 서비스 추가", "Must not happen: 잠금화면에 카드 내용 노출"],
      waitsOn: [
        { node: "busyboy/cards-ui", criterion: "2" },
        { node: "skills/align-plan", criterion: "5" },
      ],
      criteria: [
        {
          id: "1",
          text: "답할 카드가 생기면 1분 안에 폰 알림",
          check: "evidence",
          how: "기기 녹화",
        },
      ],
    });
  });
});

describe("parseRecord on real records without a contract", () => {
  it("keeps computer-use with a missing-contract issue, its state and review findings", () => {
    const { contract, state, issues, reviewFindings, verifyRows } = parse("busyboy/computer-use");
    expect(contract).toBeNull();
    expect(issues.map((issue) => issue.kind)).toEqual(["missing_contract"]);
    expect(state).toBe("asking");
    expect(reviewFindings).toEqual([
      { id: "R1", resolved: true },
      { id: "R2", resolved: true },
      { id: "R3", resolved: false },
      { id: "R4", resolved: false },
    ]);
    expect(verifyRows).toEqual([]);
  });

  it("keeps the six remove-settle verification rows as written", () => {
    const { contract, issues, verifyRows } = parse("busyboy/remove-settle");
    expect(contract).toBeNull();
    expect(issues.map((issue) => issue.kind)).toEqual(["missing_contract"]);
    expect(verifyRows.map((row) => [row.label, row.status])).toEqual([
      ["No settle feature code left", "proven"],
      ["All packages typecheck", "proven"],
      ["Old data still loads", "proven"],
      ["Tests", "proven"],
      ["Formatting", "proven"],
      ["Lint", "proven"],
    ]);
  });

  it("keeps password-standin's numbered verification and every review finding id", () => {
    const { issues, verifyRows, reviewFindings } = parse("busyboy/password-standin");
    expect(issues.map((issue) => issue.kind)).toEqual(["missing_contract"]);
    expect(verifyRows.map((row) => row.label.slice(0, 2))).toEqual(["1.", "2.", "3.", "4.", "5."]);
    expect(verifyRows.every((row) => row.status === "proven")).toBe(true);
    expect(verifyRows[2]?.evidence).toBe("PasswordSubstitution.test (5/5).");
    expect(reviewFindings.map((finding) => finding.id).toSorted()).toEqual(
      Array.from({ length: 27 }, (_, index) => `R${index + 1}`).toSorted(),
    );
    expect(
      reviewFindings.filter((finding) => finding.resolved).map((finding) => finding.id),
    ).toEqual(["R1", "R2", "R3", "R4"]);
  });
});

describe("parseRecord on broken records", () => {
  it("marks an ALIGN.md without its title", () => {
    const { contract, issues } = parseRecord("x/no-title", {
      "ALIGN.md": "Version: 1\n\n# Success criteria\n\n## 1 · Works\n",
    });
    expect(contract?.title).toBe("x/no-title");
    expect(issues).toEqual([expect.objectContaining({ kind: "missing_title", file: "ALIGN.md" })]);
  });

  it("marks an ALIGN.md without a success criteria section", () => {
    const { contract, issues } = parseRecord("x/no-criteria", {
      "ALIGN.md": "# ALIGN: No criteria\n\n# Goal\n\nSomething.\n",
    });
    expect(contract?.criteria).toEqual([]);
    expect(issues).toEqual([
      expect.objectContaining({ kind: "missing_criteria", file: "ALIGN.md" }),
    ]);
  });

  it("marks a criteria section whose criteria are not '## n · text' headings", () => {
    const { issues } = parseRecord("x/plain-list", {
      "ALIGN.md": "# ALIGN: Plain\n\n# Success criteria\n\n1. Works\n2. Fast\n",
    });
    expect(issues.map((issue) => issue.kind)).toEqual(["missing_criteria"]);
  });

  it("marks an unreadable file and a waits-on line it cannot read, and keeps the node", () => {
    const { contract, issues } = parseRecord("x/unreadable", {
      "ALIGN.md":
        "# ALIGN: Waits\n\nWaits on: someone soon\n\n# Success criteria\n\n## 1 · Works\n",
      "VERIFY.md": { error: "EACCES" },
    });
    expect(contract?.criteria).toHaveLength(1);
    expect(issues).toEqual([
      expect.objectContaining({ kind: "unreadable_file", file: "VERIFY.md" }),
      expect.objectContaining({ kind: "invalid_line", file: "ALIGN.md" }),
    ]);
  });

  it("keeps a folder with only a STATUS.md as a node without a contract", () => {
    const { contract, state, issues } = parseRecord("x/status-only", {
      "STATUS.md": "# STATUS\n\n- State: running\n",
    });
    expect(contract).toBeNull();
    expect(state).toBe("running");
    expect(issues.map((issue) => issue.kind)).toEqual(["missing_contract"]);
  });
});

describe("nodes built from real records", () => {
  it("pass the node and status JSON Schemas", () => {
    const decodeContract = Schema.decodeUnknownExit(NodeContract);
    const decodeStatus = Schema.decodeUnknownExit(NodeStatus);
    for (const id of Object.keys(REAL_RECORDS) as Array<keyof typeof REAL_RECORDS>) {
      const parsed = parse(id);
      const status = buildStatus({
        parsed,
        asks: [],
        waiting: false,
        changes: { kind: "unavailable", reason: "test" },
      });
      if (parsed.contract !== null) {
        expect(decodeContract(JSON.parse(JSON.stringify(parsed.contract)))._tag).toBe("Success");
      }
      expect(decodeStatus(JSON.parse(JSON.stringify(status)))._tag).toBe("Success");
    }
  });
});
