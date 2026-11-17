import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";
import { addRecordTask } from "./support/record-tasks";

const TITLES = ["One", "Two", "Three", "Four", "Five", "Six"];

type Verdict = "pass" | "fail" | "pending";

function align(count: number, status = "approved by ada on 2026-11-01") {
  const items = TITLES.slice(0, count)
    .map((title, index) => `## ${index + 1} · ${title}`)
    .join("\n\n");
  return `# ALIGN: Work\n\nVersion: 1 · Status: ${status}\n\n# End state\n\n${items}\n`;
}

function verify(results: Verdict[]) {
  const rows = results
    .map((result, index) => `| ${index + 1} · ${TITLES[index]} | ${result} | noted |`)
    .join("\n");
  return `| Criterion | Result | Evidence |\n| --- | --- | --- |\n${rows}\n`;
}

const OPEN_DECISION = "## Pending\n\n- Root: Which region? · one-way · open · acme/app/task\n";

function writeManagers(home: string, managers: { id: string; name: string; project: string }[]) {
  const file = join(home, "app-settings.json");
  const settings = JSON.parse(readFileSync(file, "utf8")) as {
    managers?: unknown;
    companion?: string;
  };
  settings.companion = "jota";
  settings.managers = managers.map((manager) => ({
    ...manager,
    createdAt: new Date(0).toISOString(),
  }));
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
const director = (page: Page) => chats(page).getByRole("link", { name: "Jota, director" });
const manager = (page: Page, name: string) =>
  chats(page).getByRole("listitem", { name, exact: true }).getByRole("link");

async function open(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
  await expect(chats(page)).toHaveAttribute("data-loaded", "true");
}

async function shot(page: Page, name: string) {
  await chats(page).screenshot({ path: test.info().outputPath(name), animations: "disabled" });
}

test("the chat list should show a calm fraction and nothing for an unaligned project", async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web", "api", "notes"]);
  writeManagers(home, [
    { id: "webby", name: "Web", project: "web" },
    { id: "apily", name: "Api", project: "api" },
    { id: "notesy", name: "Notes", project: "notes" },
  ]);
  await addRecordTask(home, {
    project: "web",
    projectPath: projects.web,
    id: "web-calm",
    title: "Ship the footer",
    files: { "ALIGN.md": align(5), "VERIFY.md": verify(["pass", "pass", "pass", "pass", "pass"]) },
  });
  await addRecordTask(home, {
    project: "api",
    projectPath: projects.api,
    id: "api-calm",
    title: "Ship the check",
    files: { "ALIGN.md": align(3), "VERIFY.md": verify(["pass", "pass", "pass"]) },
  });
  await addRecordTask(home, {
    project: "notes",
    projectPath: projects.notes,
    id: "notes-draft",
    title: "Draft the plan",
    files: { "ALIGN.md": align(4, "draft"), "VERIFY.md": verify(["pass", "pass", "pass", "pass"]) },
  });

  await open(page);
  const list = chats(page);
  await expect(director(page)).toContainText("8/8");
  await expect(director(page)).toHaveAccessibleName("Jota, director, All verified, 8/8");
  await expect(director(page).locator('[data-state="complete"]')).toHaveAttribute(
    "aria-label",
    "All verified",
  );
  await expect(director(page).locator('[data-state="complete"] title')).toHaveText("All verified");
  await expect(director(page).locator('[data-state="complete"]')).toHaveClass(
    /text-success-foreground/,
  );
  await expect(list.getByText("at risk")).toHaveCount(0);
  await expect(list.getByText("Needs a decision")).toHaveCount(0);

  const web = manager(page, "Web");
  await expect(web).toContainText("5/5");
  expect(await web.innerText()).not.toContain("All verified");
  await expect(web.locator('[data-state="complete"]')).toHaveAttribute(
    "aria-label",
    "All verified",
  );
  await expect(web.locator('[data-state="complete"]')).toHaveClass(/text-success-foreground/);
  await expect(web.locator("[data-progress]")).toHaveClass(/text-\[#8d8d93\]/);
  await expect(manager(page, "Api")).toContainText("3/3");
  await expect(manager(page, "Api").locator('[data-state="complete"]')).toBeVisible();
  await expect(manager(page, "Notes")).not.toContainText(/\d+\s*\/\s*\d+/);
  await expect(manager(page, "Notes").locator("[data-progress]")).toHaveCount(0);
  await shot(page, "sidebar-calm-director.png");

  await web.click();
  await expect(web).toHaveAttribute("aria-current", "page");
  await page.mouse.move(640, 360);
  await expect(web.getByText("5/5")).toBeVisible();
  await expect(director(page)).toContainText("8/8");
  await expect(manager(page, "Notes")).not.toContainText(/\d+\s*\/\s*\d+/);
  await shot(page, "sidebar-calm-project.png");
});

test("the chat list should mark at risk and a decision with an icon", async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, [
    "web",
    "api",
    "docs",
    "quiet",
    "notes",
  ]);
  writeManagers(home, [
    { id: "webby", name: "Web", project: "web" },
    { id: "apily", name: "Api", project: "api" },
    { id: "docsy", name: "Docs", project: "docs" },
    { id: "quiety", name: "Quiet", project: "quiet" },
    { id: "notesy", name: "Notes", project: "notes" },
  ]);
  await addRecordTask(home, {
    project: "web",
    projectPath: projects.web,
    id: "web-risk",
    title: "Fix the health check",
    files: {
      "ALIGN.md": align(5),
      "VERIFY.md": verify(["pass", "pass", "pass", "fail", "pending"]),
    },
  });
  await addRecordTask(home, {
    project: "api",
    projectPath: projects.api,
    id: "api-decision",
    title: "Ask the region",
    files: {
      "ALIGN.md": align(6),
      "VERIFY.md": verify(["pass", "pass", "pass", "pass", "pending", "pending"]),
      "STATUS.md": OPEN_DECISION,
    },
  });
  await addRecordTask(home, {
    project: "docs",
    projectPath: projects.docs,
    id: "docs-calm",
    title: "Ship the guide",
    files: { "ALIGN.md": align(5), "VERIFY.md": verify(["pass", "pass", "pass", "pass", "pass"]) },
  });
  await addRecordTask(home, {
    project: "quiet",
    projectPath: projects.quiet,
    id: "quiet-part",
    title: "Write the notes",
    files: { "ALIGN.md": align(4), "VERIFY.md": verify(["pass", "pass", "pending", "pending"]) },
  });
  await addRecordTask(home, {
    project: "notes",
    projectPath: projects.notes,
    id: "notes-draft",
    title: "Draft the plan",
    files: { "ALIGN.md": align(4, "draft"), "VERIFY.md": verify(["pass", "pass", "pass", "pass"]) },
  });

  await open(page);
  const jota = director(page);
  await expect(jota).toContainText("14/20");
  expect(await jota.innerText()).not.toContain("At risk");
  expect(await jota.innerText()).not.toContain("Needs a decision");
  await expect(jota).toHaveAccessibleName("Jota, director, At risk, Needs a decision, 14/20");
  const icons = jota.locator("[data-state]");
  await expect(icons).toHaveCount(2);
  await expect(icons.nth(0)).toHaveAttribute("data-state", "at-risk");
  await expect(icons.nth(0)).toHaveAttribute("aria-label", "At risk");
  await expect(icons.nth(0)).toHaveClass(/text-destructive/);
  await expect(icons.nth(1)).toHaveAttribute("data-state", "decision");
  await expect(icons.nth(1)).toHaveAttribute("aria-label", "Needs a decision");
  await expect(icons.nth(1)).toHaveClass(/text-warning-foreground/);

  const web = manager(page, "Web");
  await expect(web).toContainText("3/5");
  expect(await web.innerText()).not.toContain("At risk");
  await expect(web.locator('[data-state="at-risk"]')).toHaveAttribute("aria-label", "At risk");
  await expect(web.locator('[data-state="at-risk"]')).toHaveClass(/text-destructive/);
  const api = manager(page, "Api");
  await expect(api).toContainText("4/6");
  expect(await api.innerText()).not.toContain("Needs a decision");
  await expect(api.locator('[data-state="decision"]')).toHaveAttribute(
    "aria-label",
    "Needs a decision",
  );
  await expect(api.locator('[data-state="decision"]')).toHaveClass(/text-warning-foreground/);
  await expect(manager(page, "Docs")).toContainText("5/5");
  await expect(manager(page, "Docs").locator('[data-state="complete"]')).toHaveClass(
    /text-success-foreground/,
  );
  const quiet = manager(page, "Quiet");
  await expect(quiet).toContainText("2/4");
  await expect(quiet.locator("[data-state]")).toHaveCount(0);
  await expect(manager(page, "Notes")).not.toContainText(/\d+\s*\/\s*\d+/);
  await shot(page, "sidebar-attention-director.png");

  await api.click();
  await expect(api).toHaveAttribute("aria-current", "page");
  await page.mouse.move(640, 360);
  await expect(api.getByText("4/6")).toBeVisible();
  await expect(api.locator('[data-state="decision"]')).toBeVisible();
  await expect(web.getByText("3/5")).toBeVisible();
  await expect(web.locator('[data-state="at-risk"]')).toBeVisible();
  await expect(jota).toContainText("14/20");
  expect(await jota.innerText()).not.toContain("At risk");
  await shot(page, "sidebar-attention-project.png");
});
