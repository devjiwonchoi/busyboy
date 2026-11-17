import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  localIsoDate,
  readRecordsForWeek,
  TEST_REMEMBER_ROOT,
} from "@/server/records/remember-record";

import { useProjectsHome } from "./support/projects-home";

const REQUEST = "Add a health check that reports whether the service is up.";
const FOLLOW_UP = "Also include the service version in the health response.";
// Vendored from devjiwonchoi/skills@f179d4d3 skills/utils/retro/delegation-rate.
// A named file is checked whatever it is called, so it accepts REMEMBER.md.
const DELEGATION_RATE = join(__dirname, "fixtures", "delegation-rate.sh");

type StoredTask = { id: string; title: string; worktree: string };

function storedTasks(home: string): StoredTask[] {
  return (JSON.parse(readFileSync(join(home, "task-list.json"), "utf8")) as { tasks: StoredTask[] })
    .tasks;
}

function frontMatter(text: string): Record<string, string> {
  const body = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  return Object.fromEntries(
    body
      .split(/\r?\n/)
      .filter((line) => line.includes(":"))
      .map((line) => {
        const index = line.indexOf(":");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

async function callTool(request: APIRequestContext, name: string, args: Record<string, string>) {
  const response = await request.post("/api/mcp", {
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  return { isError: Boolean(body.result.isError), text: body.result.content[0].text };
}

async function openChat(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
}

const transcript = (page: Page) => page.getByRole("log", { name: "Transcript" });
const taskLine = (page: Page, name: string) =>
  page.getByRole("group", { name: "Tasks" }).getByRole("listitem", { name });

test("finishing a task should write REMEMBER.md the delegation rate accepts", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web"]);
  execFileSync("git", [
    "-C",
    projects.web,
    "remote",
    "add",
    "origin",
    "https://github.com/example/health-app.git",
  ]);
  await openChat(page);
  await callTool(context.request, "create_task", {
    project: "web",
    title: "Add a health check",
    request: REQUEST,
  });

  const card = transcript(page).getByRole("group", { name: "Plan from web · Add a health check" });
  await expect(card).toContainText(
    "When done: a health check that reports whether the service is up",
  );
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0);

  const line = taskLine(page, "web · Add a health check");
  await expect(line.locator("[data-status]")).toHaveText("Idle");
  await line.getByRole("button", { name: "Message web · Add a health check" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill(FOLLOW_UP);
  await page.getByRole("button", { name: "Send" }).click();

  const task = storedTasks(home).find((item) => item.title === "Add a health check")!;
  const root = join(home, TEST_REMEMBER_ROOT);
  const recordPath = join(root, "example", "health-app", task.id, "REMEMBER.md");
  await expect
    .poll(
      () => {
        try {
          return readFileSync(recordPath, "utf8");
        } catch {
          return "";
        }
      },
      { timeout: 20_000 },
    )
    .toContain("delegated: false");

  await expect(
    transcript(page).getByRole("group", { name: "Done from web · Add a health check" }),
  ).toContainText("Add a health check · Done");

  const text = readFileSync(recordPath, "utf8");
  const today = localIsoDate();
  expect(frontMatter(text)).toMatchObject({
    date: today,
    interventions_after_approval: "1",
    end_state_items_total: "2",
    end_state_items_met: "1",
    review_change_requests: "0",
    delegated: "false",
  });
  expect(text).toContain("User messages after approval: 1");
  expect(text).toContain("Not delegated: interventions_after_approval, end_state_incomplete.");
  expect(readFileSync(join(root, "VERSION"), "utf8").trim()).toBe("1");

  const rated = execFileSync("sh", [DELEGATION_RATE, recordPath], { encoding: "utf8" });
  expect(rated).toContain("tasks: 1");
  expect(rated).toContain("delegated: 0");
  expect(rated).toContain("delegation_rate: 0/1");
  expect(rated).toContain("reasons: interventions_after_approval end_state_incomplete");
  expect(rated).toContain(realpathSync(recordPath));
  expect(existsSync(join(homedir(), ".jwn", "example", "health-app", task.id, "REMEMBER.md"))).toBe(
    false,
  );

  const week = await readRecordsForWeek(root);
  expect(week.records).toEqual([
    expect.objectContaining({
      path: recordPath,
      date: today,
      interventionsAfterApproval: 1,
      endStateItemsTotal: 2,
      endStateItemsMet: 1,
      reviewChangeRequests: 0,
      delegated: false,
      reasons: ["interventions_after_approval", "end_state_incomplete"],
    }),
  ]);
  expect(week.rejected).toEqual([]);
  expect(rated).toContain(`week: ${week.week}`);
  expect(rated).toContain(`week_start: ${week.weekStart}`);
  expect(rated).toContain(`week_end: ${week.weekEnd}`);

  // The old name still counts, and a leftover RETRO.md does not replace REMEMBER.md in the same task.
  const legacyDir = join(root, "example", "health-app", "legacy-task");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    join(legacyDir, "RETRO.md"),
    `---\ndate: ${today}\ninterventions_after_approval: 0\nend_state_items_total: 1\nend_state_items_met: 1\nreview_change_requests: 0\ndelegated: true\n---\n\n# Remember\n\nNo observed problem.\n`,
  );
  writeFileSync(
    join(root, "example", "health-app", task.id, "RETRO.md"),
    `---\ndate: ${today}\ninterventions_after_approval: 0\nend_state_items_total: 1\nend_state_items_met: 1\nreview_change_requests: 3\ndelegated: true\n---\n`,
  );
  const both = await readRecordsForWeek(root);
  expect(both.rejected).toEqual([]);
  expect(both.records.map((record) => record.path).sort()).toEqual(
    [recordPath, join(legacyDir, "RETRO.md")].sort(),
  );
  expect(both.records.find((record) => record.path === recordPath)).toMatchObject({
    reviewChangeRequests: 0,
    delegated: false,
  });
  expect(both.records.find((record) => record.path.endsWith("RETRO.md"))).toMatchObject({
    delegated: true,
    interventionsAfterApproval: 0,
  });
});
