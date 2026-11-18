import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { removeFolder, useTestHome } from "./support/test-home";

const PLAIN_PROMPT = "Reply with exactly this sentence and nothing else: Hello from busyboy.";

const folders: string[] = [];

test.afterEach(() => {
  for (const folder of folders.splice(0)) removeFolder(folder);
});

function track(folder: string) {
  folders.push(folder);
  return folder;
}

function readSettings(home: string) {
  return JSON.parse(readFileSync(join(home, "app-settings.json"), "utf8")) as {
    projects: unknown[];
    alwaysAsk: unknown;
    defaultProvider: string | null;
    setupCompletedAt: string | null;
  };
}

async function continueFromHarness(page: Page) {
  await expect(page.getByRole("heading", { name: "Sign in to an agent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pick a Director" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Add skills" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Always ask before" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Add projects" })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue" }).click();
}

test("finishing setup should open the director with no project", async ({
  page,
  context,
  baseURL,
}) => {
  const home = track(
    await useTestHome(context, baseURL!, { claude: "signed-in", codex: "signed-out" }),
  );

  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  const agents = page.getByRole("list", { name: "Agents" });
  await expect(agents.getByRole("listitem").filter({ hasText: "Claude Code" })).toContainText(
    "Signed in",
  );
  await expect(agents.getByRole("listitem").filter({ hasText: "Codex" })).toContainText(
    "Signed out",
  );
  await expect(page.getByLabel("Codex login command")).toHaveValue("codex login");
  await continueFromHarness(page);

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
  await expect(page.getByText("No managers yet.")).toHaveCount(0);
  const settings = readSettings(home);
  expect(settings.projects).toEqual([]);
  expect(settings.alwaysAsk ?? null).toBeNull();
  expect(settings.setupCompletedAt).toEqual(expect.any(String));
  const chat = page.getByRole("region", { name: "Chat" });
  await expect(chat.getByText("Director", { exact: true }).first()).toBeVisible();
  await expect(chat.getByText("BusyBoy is ready. What should we work on?")).toBeVisible();

  await page.getByRole("textbox", { name: "Message" }).fill(PLAIN_PROMPT);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.getByRole("log", { name: "Transcript" }).getByText("Hello from busyboy.", { exact: true }),
  ).toBeVisible();
});

test("continuing without a signed-in agent should not be possible", async ({
  page,
  context,
  baseURL,
}) => {
  track(await useTestHome(context, baseURL!, { claude: "signed-out", codex: "signed-out" }));

  await page.goto("/setup");

  await expect(page.getByLabel("Claude Code login command")).toHaveValue("claude /login");
  await expect(page.getByText("Sign in to an agent to continue.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
});

test("an outdated Claude Code should ask for an update before continuing", async ({
  page,
  context,
  baseURL,
}) => {
  track(await useTestHome(context, baseURL!, { claude: "outdated", codex: "signed-out" }));

  await page.goto("/setup");

  const agents = page.getByRole("list", { name: "Agents" });
  await expect(agents.getByRole("listitem").filter({ hasText: "Claude Code" })).toContainText(
    "Update needed",
  );
  await expect(page.getByLabel("Claude Code update command")).toHaveValue("claude update");
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
});

test("choosing a default agent should save it and open the director", async ({
  page,
  context,
  baseURL,
}) => {
  const home = track(
    await useTestHome(context, baseURL!, { claude: "signed-in", codex: "signed-in" }),
  );

  await page.goto("/setup");
  await page.getByRole("radio", { name: "Use Codex by default" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
  expect(readSettings(home).defaultProvider).toBe("codex");
});

test("opening the app after setup should skip setup", async ({ page, context, baseURL }) => {
  track(await useTestHome(context, baseURL!, { claude: "signed-in" }));

  await page.goto("/setup");
  await continueFromHarness(page);
  await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();

  // why: Two open main screens fill Chromium's six connections per host, which stalls the next navigation.
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/");
  await expect(reopened).toHaveURL(/\/$/);
  await expect(reopened.getByRole("region", { name: "Chat" })).toBeVisible();
  await expect(reopened.getByText("No managers yet.")).toHaveCount(0);
});

test("opening the app with a corrupt settings file should show the harness step again", async ({
  page,
  context,
  baseURL,
}) => {
  const home = track(await useTestHome(context, baseURL!, { claude: "signed-in" }));
  const corrupt = '{"setupCompletedAt": "2026-11-14T00:00:00.000Z", "projects": [';
  writeFileSync(join(home, "app-settings.json"), corrupt);

  await page.goto("/");

  await expect(page).toHaveURL(/\/setup$/);
  const moved = readdirSync(home).filter((name) => /^app-settings\.corrupt-.+\.json$/.test(name));
  expect(moved).toHaveLength(1);
  expect(readFileSync(join(home, moved[0]), "utf8")).toBe(corrupt);

  await continueFromHarness(page);
  await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
});

test("going back from settings after signing out should open the director", async ({
  page,
  context,
  baseURL,
}) => {
  track(await useTestHome(context, baseURL!, { claude: "signed-in" }));

  await page.goto("/setup");
  await continueFromHarness(page);
  await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();

  await context.addCookies([
    { name: "busyboy-test-sign-in", value: "claude=signed-out,codex=signed-out", url: baseURL! },
  ]);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Agents" }).click();
  const agents = page.getByRole("list", { name: "Agents" });
  await expect(agents.getByRole("listitem").filter({ hasText: "Claude Code" })).toContainText(
    "Signed out",
  );

  await page.getByRole("link", { name: "Back to chat" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
});

test("finishing setup should link a skills checkout into the harness", async ({
  page,
  context,
  baseURL,
}) => {
  const home = track(await useTestHome(context, baseURL!, { claude: "signed-in" }));
  const skill = join(home, "skills-source", "skills", "align");
  mkdirSync(join(home, "skills-source", ".claude-plugin"), { recursive: true });
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(home, "skills-source", ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "jwn" })}\n`,
  );
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: align\ndescription: Plan the task before changing files.\n---\n\nFollow align.\n",
  );

  await page.goto("/setup");
  await continueFromHarness(page);
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
  expect(existsSync(join(home, "harness-skills", "align", "SKILL.md"))).toBe(true);

  const message = page.getByRole("textbox", { name: "Message" });
  await message.click();
  await message.pressSequentially("/");
  await expect(
    page.getByRole("listbox", { name: "Choose a skill or command" }).getByRole("option", {
      name: /align/,
    }),
  ).toBeVisible();
});
