import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";
import { addRecordTask } from "./support/record-tasks";

type Progress = { total: number; verified: number; state: "calm" | "decision" | "at-risk" };
type GraphTask = { id: string; progress: Progress };
type GraphProject = { name: string; tasks: GraphTask[]; progress: Progress };
type Graph = { projects: GraphProject[]; progress: Progress; error?: string };

const SHIP = "ship-footer";
const ASK = "ask-region";
const FIX = "fix-health";
const DRAFT = "draft-plan";
const LATE = "late-notes";
const QUIET = "quiet-check";
const LIGHT = "light-note";

function align(title: string, status: string, body: string) {
  return `# ALIGN: ${title}\n\nVersion: 1 · Status: ${status}\n\n${body}`;
}

const endState = (items: string) =>
  `# End state\n\n${items}\n\n# Later\n\n- Something agreed and left for later\n`;

async function graphOf(page: Page): Promise<Graph> {
  await page.goto("/");
  return page.evaluate(
    () =>
      new Promise<Graph>((resolve, reject) => {
        const source = new EventSource("/api/records/events");
        const timer = window.setTimeout(() => {
          source.close();
          reject(new Error("The records stream sent nothing."));
        }, 10_000);
        source.onmessage = (message) => {
          window.clearTimeout(timer);
          source.close();
          resolve(JSON.parse(message.data) as Graph);
        };
        source.onerror = () => {
          window.clearTimeout(timer);
          source.close();
          reject(new Error("The records stream failed."));
        };
      }),
  );
}

test("reading task records should report each project's progress and the director total", async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web", "api"]);
  execFileSync("git", [
    "-C",
    projects.web,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/web.git",
  ]);
  execFileSync("git", [
    "-C",
    projects.api,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/api.git",
  ]);

  const ship = await addRecordTask(home, {
    project: "web",
    projectPath: projects.web,
    id: SHIP,
    title: "Ship the footer",
    files: {
      "ALIGN.approved.md": align(
        "Ship the footer",
        "approved by ada on 2026-11-01",
        endState(
          `## E2E workflow\n\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n\n## 1 · The footer shows the project name\n\n- Proof: test \`the footer journey passes\`\n\n## 2 · The year shows beside the name\n\n- Proof: test \`the year journey passes\``,
        ),
      ),
      "ALIGN.md": align(
        "Ship the footer",
        "draft",
        endState("## 1 · One\n\n## 2 · Two\n\n## 3 · Three\n\n## 4 · Four\n\n## 5 · Five"),
      ),
      "VERIFY.md": `# VERIFY\n\n## 1 · The footer shows the project name\n\n- Result: pass\n- Proof: the footer journey\n- Wanted: the name\n- Got: the name\n- footer-shows: pass\n\n## 2 · The year shows beside the name\n\n- Result: pass\n- Proof: the year journey\n- Wanted: the year\n- Got: the year\n`,
      "STATUS.md":
        "- Stage: Verify\n- State: running\n- Deadline: 2999-01-01\n\n## Pending\n\n- Root: Rename the helper? · two-way · open · acme/web/ship-footer\n",
    },
  });
  await addRecordTask(home, {
    project: "web",
    projectPath: projects.web,
    id: ASK,
    title: "Ask the region",
    files: {
      "ALIGN.approved.md": align(
        "Ask the region",
        "approved by ada on 2026-11-02",
        endState(
          "## 1 · The region is chosen\n\n- Proof: URL <the settings page shows the region>",
        ),
      ),
      "VERIFY.md":
        "## 1 · The region is chosen\n\n- Result: unresolved\n- Proof: none\n- Wanted: a region\n- Got: no answer\n",
      "STATUS.md":
        "## Pending\n\n- Root: Which region? · one-way · open · acme/web/ask-region\n- Root: Pay the invoice? · one-way · covered by rules.md · acme/web/ask-region\n- Root: Name the helper? · two-way · open · acme/web/ask-region\n",
    },
  });
  await addRecordTask(home, {
    project: "web",
    projectPath: projects.web,
    id: FIX,
    title: "Fix the health check",
    files: {
      "ALIGN.approved.md": align(
        "Fix the health check",
        "approved by ada on 2026-11-03",
        endState("## 1 · The check passes\n\n- Proof: command `pnpm test` exits 0"),
      ),
      "VERIFY.md":
        "## 1 · The check passes\n\n- Result: fail\n- Proof: pnpm test\n- Wanted: exit 0\n- Got: exit 1\n",
      "STATUS.md": "## Pending\n\n- Root: Ship anyway? · one-way · open · acme/web/fix-health\n",
    },
  });
  await addRecordTask(home, {
    project: "web",
    projectPath: projects.web,
    id: DRAFT,
    title: "Draft the plan",
    files: {
      "ALIGN.md": align(
        "Draft the plan",
        "draft",
        endState("## 1 · One\n\n## 2 · Two\n\n## 3 · Three\n\n## 4 · Four"),
      ),
      "VERIFY.md": "## 1 · One\n\n- Result: pass\n",
    },
  });
  await addRecordTask(home, {
    project: "api",
    projectPath: projects.api,
    id: LATE,
    title: "Late notes",
    files: {
      "ALIGN.md": align(
        "Late notes",
        "approved by ada on 2026-11-04",
        endState("## 1 · The notes are published\n\n- Proof: URL <the notes page>"),
      ),
      "VERIFY.md":
        "| Criterion | Result | Evidence |\n| --- | --- | --- |\n| 1 · The notes are published | PASS | the page loaded |\n",
      "STATUS.md": "- Deadline: 2020-01-01\n",
    },
  });
  await addRecordTask(home, {
    project: "api",
    projectPath: projects.api,
    id: QUIET,
    title: "Quiet check",
    files: {
      "ALIGN.md": align(
        "Quiet check",
        "approved by ada on 2026-11-05",
        "# Success criteria\n\n## 1 · The log line is written\n\n## 2 · The log line names the service\n",
      ),
      "VERIFY.md":
        "| Criterion | Result | Evidence |\n| --- | --- | --- |\n| 1 · The log line is written | PASS | log showed it |\n| 2 · The log line names the service | pending | not run |\n",
    },
  });
  await addRecordTask(home, {
    project: "api",
    projectPath: projects.api,
    id: LIGHT,
    title: "Save a note",
    files: {
      "ALIGN.md":
        "# ALIGN: Save a note\n\nVersion: 1 · Status: approved by ada on 2026-11-06\n\n- Done when: the note is saved\n",
      "VERIFY.md": "- the note is saved: pass\n",
    },
  });

  const decoy = join(ship.worktree, ".jwn", SHIP);
  mkdirSync(decoy, { recursive: true });
  writeFileSync(
    join(decoy, "ALIGN.approved.md"),
    align(
      "Decoy",
      "approved by ada on 2026-11-01",
      endState(
        "## 1 · A\n\n## 2 · B\n\n## 3 · C\n\n## 4 · D\n\n## 5 · E\n\n## 6 · F\n\n## 7 · G\n\n## 8 · H\n\n## 9 · I",
      ),
    ),
  );

  const graph = await graphOf(page);
  expect(graph.error).toBeUndefined();

  const project = (name: string) => {
    const found = graph.projects.find((entry) => entry.name === name);
    expect(found, name).toBeDefined();
    return found!;
  };
  const task = (name: string, id: string) => {
    const found = project(name).tasks.find((entry) => entry.id === id);
    expect(found, id).toBeDefined();
    return found!.progress;
  };

  expect(task("web", SHIP)).toEqual({ total: 2, verified: 2, state: "calm" });
  expect(task("web", ASK)).toEqual({ total: 1, verified: 0, state: "decision" });
  expect(task("web", FIX)).toEqual({ total: 1, verified: 0, state: "at-risk" });
  expect(task("web", DRAFT)).toEqual({ total: 0, verified: 0, state: "calm" });
  expect(project("web").progress).toEqual({ total: 4, verified: 2, state: "at-risk" });

  expect(task("api", LATE)).toEqual({ total: 1, verified: 1, state: "at-risk" });
  expect(task("api", QUIET)).toEqual({ total: 2, verified: 1, state: "calm" });
  expect(task("api", LIGHT)).toEqual({ total: 1, verified: 1, state: "calm" });
  expect(project("api").progress).toEqual({ total: 4, verified: 3, state: "at-risk" });

  expect(graph.progress).toEqual({ total: 8, verified: 5, state: "at-risk" });
});
