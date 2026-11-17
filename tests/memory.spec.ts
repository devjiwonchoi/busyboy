import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";

const REMEMBER = "Remember that I prefer pnpm over npm.";
const WORK = "In @web, set up the package manager.";
const PROMPT_FILE = "busyboy-prompt.txt";

async function openChat(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

async function waitForReplies(page: Page, count: number) {
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByLabel("Reply", { exact: true })).toHaveCount(count);
  await expect(transcript).toHaveAttribute("data-status", "idle");
}

test("telling the director to remember a preference should save it", async ({
  page,
  context,
  baseURL,
}) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);

  await send(page, REMEMBER);

  await waitForReplies(page, 1);
  expect(readFileSync(join(home, "memory", "prefers-pnpm.md"), "utf8")).toBe(
    "# Prefers pnpm\n\nThe user prefers pnpm over npm.\n",
  );
  expect(readFileSync(join(home, "memory", "MEMORY.md"), "utf8")).toContain(
    "[Prefers pnpm](prefers-pnpm.md)",
  );
});

test("a saved preference should reach the next task", async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);
  await send(page, REMEMBER);
  await waitForReplies(page, 1);

  await send(page, WORK);

  await waitForReplies(page, 2);
  const line = page
    .getByRole("group", { name: "Tasks" })
    .getByRole("listitem", { name: "web · Set up package manager" });
  await expect(line).toBeVisible();
  const [task] = (
    JSON.parse(readFileSync(join(home, "task-list.json"), "utf8")) as {
      tasks: { worktree: string }[];
    }
  ).tasks;
  const promptFile = join(task.worktree, PROMPT_FILE);
  const readPrompt = () => (existsSync(promptFile) ? readFileSync(promptFile, "utf8") : "");
  await expect.poll(readPrompt).toContain("# Memory");
  const prompt = readPrompt();
  // Instructions first, then memory: the order that keeps the prompt cache.
  expect(prompt).toContain('You are a busyboy task agent for the project "web".');
  expect(prompt).toContain("### Prefers pnpm\nThe user prefers pnpm over npm.");
  expect(prompt.indexOf("# Memory")).toBeGreaterThan(
    prompt.indexOf("You are a busyboy task agent"),
  );
});
