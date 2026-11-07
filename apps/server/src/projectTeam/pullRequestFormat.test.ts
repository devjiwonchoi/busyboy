import { describe, expect, it } from "@effect/vitest";

import { PR_TITLE_MAX_CHARS, pullRequestFormatProblems } from "./pullRequestFormat.ts";

const body = [
  "### Why?",
  "",
  "Tasks moved to In Review even when the pull request ignored the PR rules.",
  "",
  "### How?",
  "",
  "The server reads the pull request and refuses the move until it conforms.",
  "",
].join("\n");

const good = { title: "Check pull request format", body };

const problemsFor = (overrides: Partial<typeof good>) =>
  pullRequestFormatProblems({ ...good, ...overrides });

describe("pullRequestFormatProblems", () => {
  it("passes a conforming pull request", () => {
    expect(pullRequestFormatProblems(good)).toEqual([]);
  });

  it("passes a conforming body with a stack line and CRLF line endings", () => {
    const stacked = `Stacked on #133.\n\n${body}`.replace(/\n/g, "\r\n");
    expect(problemsFor({ body: stacked })).toEqual([]);
  });

  it("refuses a long title", () => {
    const title = `Add ${"very ".repeat(15)}long title`;
    expect(title.length).toBeGreaterThan(PR_TITLE_MAX_CHARS);
    const problems = problemsFor({ title });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`(${PR_TITLE_MAX_CHARS} chars max)`);
    expect(problems[0]).toContain(JSON.stringify(title));
  });

  it("refuses a title with a task key", () => {
    const problems = problemsFor({ title: "Check pull request format BU-61" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("BU-61");
  });

  it("refuses the colon-list title with a key", () => {
    const problems = problemsFor({
      title:
        "Show task dependencies Linear-style: blocked flags, subtask progress, Structure section (BU-57)",
    });
    expect(problems.some((problem) => problem.includes("chars max"))).toBe(true);
    expect(problems.some((problem) => problem.includes("BU-57"))).toBe(true);
    expect(problems.some((problem) => problem.includes("colon"))).toBe(true);
  });

  it("refuses a lowercase title and a trailing period", () => {
    const problems = problemsFor({ title: "fix login redirect." });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("period");
    expect(problems[1]).toContain("action verb");
  });

  it("refuses a body without ### Why?", () => {
    const problems = problemsFor({ body: "### How?\n\nIt reads the PR.\n" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no "### Why?"');
  });

  it("refuses a body without ### How?", () => {
    const problems = problemsFor({
      body: "### Why?\n\nThe rules were ignored.\n",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no "### How?"');
  });

  it("refuses sections in the wrong order", () => {
    const problems = problemsFor({
      body: "### How?\n\nIt reads the PR.\n\n### Why?\n\nThe rules were ignored.\n",
    });
    expect(problems).toEqual([
      '"### How?" comes before "### Why?": put "### Why?" first, then "### How?".',
    ]);
  });

  it("refuses an empty section", () => {
    const problems = problemsFor({
      body: "### Why?\n\n### How?\n\nIt reads the PR.\n",
    });
    expect(problems).toEqual([
      'The "### Why?" section is empty: write at least one paragraph under it.',
    ]);
  });

  it("refuses an extra section", () => {
    const problems = problemsFor({
      body: `${body}\n## What changes\n\n- a thing\n`,
    });
    expect(problems).toEqual([
      'Remove the "## What changes" section: the body has only ### Why? and ### How?',
    ]);
  });

  it("refuses text before ### Why?", () => {
    const problems = problemsFor({
      body: `## Summary\n\nThis PR does things.\n\n${body}`,
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('"## Summary"');
    expect(problems[1]).toContain('text before "### Why?"');
  });

  it("refuses validation notes", () => {
    const validation =
      "The body has validation notes: remove validation notes; the PR body says why and how, not how it was tested.";
    expect(problemsFor({ body: `${body}\nTests: pnpm test passes\n` })).toEqual([validation]);
    expect(problemsFor({ body: `${body}\n- [x] ran tests\n` })).toEqual([validation]);
    expect(problemsFor({ body: `${body}\nI ran \`bun run test\` locally.\n` })).toEqual([
      validation,
    ]);
  });

  it("refuses a task key in the body but not standards names or PR refs", () => {
    expect(problemsFor({ body: `${body}\nThis finishes BU-61, after #120.\n` })).toEqual([
      "The body mentions BU-61: remove the task key BU-61; BusyBoy links the task itself.",
    ]);
    expect(problemsFor({ body: `${body}\nIt decodes UTF-8 and SHA-256 output.\n` })).toEqual([]);
  });
});
