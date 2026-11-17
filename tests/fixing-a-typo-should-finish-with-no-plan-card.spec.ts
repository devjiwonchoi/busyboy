import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect as baseExpect, test, type APIRequestContext, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";
import { homeRecordFolder } from "./support/record-tasks";

// why: A trivial typo fix records an approved plan and finishes in one turn.
// why: The script is tests/provider-scripts/trivial-task.json.
const REQUEST = "Fix the typo recieve in the welcome heading.";

const expect = baseExpect.configure({ timeout: 15_000 });

async function createTask(request: APIRequestContext, home: string, title: string, text: string) {
  const response = await request.post("/api/mcp", {
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_task", arguments: { project: "web", title, request: text } },
    },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  expect(body.result.isError ?? false, body.result.content[0]?.text).toBe(false);
  const { tasks } = JSON.parse(readFileSync(join(home, "task-list.json"), "utf8")) as {
    tasks: { title: string; worktree: string; id: string }[];
  };
  return tasks.find((task) => task.title === title)!;
}

async function openChat(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
}

const transcript = (page: Page) => page.getByRole("log", { name: "Transcript" });

let home: string;

test.beforeEach(async ({ context, baseURL }) => {
  ({ home } = await useProjectsHome(context, baseURL!, ["web"]));
});

test("fixing a typo should finish with no plan card", async ({ page, context }) => {
  await openChat(page);
  const task = await createTask(context.request, home, "Fix the welcome typo", REQUEST);

  const done = transcript(page).getByRole("group", {
    name: "Done from web · Fix the welcome typo",
  });
  await expect(done).toBeVisible();
  await expect(done).toContainText("Fix the welcome typo");
  await expect(done).toContainText("· Done");
  await expect(done.getByRole("button", { name: "View plan" })).toBeVisible();
  await expect(
    transcript(page).getByRole("group", { name: "Plan from web · Fix the welcome typo" }),
  ).toHaveCount(0);
  await expect(
    transcript(page).getByRole("group", { name: "Card from web · Fix the welcome typo" }),
  ).toHaveCount(0);
  await expect(
    transcript(page).getByLabel("web · Fix the welcome typo", { exact: true }),
  ).toContainText("Archived");

  await done.getByRole("button", { name: "View plan" }).click();
  const details = page.getByRole("dialog", { name: "Fix the welcome typo" });
  await expect(details).toContainText("The welcome heading spells receive correctly.");
  await expect(details.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(
    transcript(page).getByRole("group", { name: "Plan from web · Fix the welcome typo" }),
  ).toHaveCount(0);

  const records = await homeRecordFolder(home, {
    id: task.id,
    project: "web",
    worktree: task.worktree,
  });
  const plan = readFileSync(join(records, "ALIGN.md"), "utf8");
  expect(plan).toMatch(/Status:\s*approved\b/);
  expect(plan).not.toMatch(/Status:\s*draft\b/);
});
