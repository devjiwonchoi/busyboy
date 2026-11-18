import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";
import {
  createGitRepository,
  createTempFolder,
  removeFolder,
  useTestHome,
} from "./support/test-home";

const folders: string[] = [];

test.afterEach(() => {
  for (const folder of folders.splice(0)) removeFolder(folder);
});

async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("main", { name: "Settings" })).toBeVisible();
}

test("a browser should label Settings as dev and the chat should not", async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web"], {
    claude: "signed-in",
  });
  folders.push(home, ...Object.values(projects).map((path) => dirname(path)));

  await page.goto("/");
  await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
  await expect(page.getByText("BusyBoy dev", { exact: true })).toHaveCount(0);
  await expect(page.getByText("BusyBoy 0.0.0", { exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("BusyBoy dev", { exact: true })).toBeVisible();
  await expect(page.getByText("BusyBoy 0.0.0", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "Projects" }).click();
  await expect(page.getByText("BusyBoy dev", { exact: true })).toBeVisible();
});

test("settings should show the desktop app version from the bridge", async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web"], {
    claude: "signed-in",
  });
  folders.push(home, ...Object.values(projects).map((path) => dirname(path)));
  await page.addInitScript(() => {
    Object.assign(window, {
      busyboyDesktop: { appVersion: async () => "0.0.30" },
    });
  });

  await page.goto("/");
  await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
  await expect(page.getByText("BusyBoy 0.0.30", { exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("BusyBoy 0.0.30", { exact: true })).toBeVisible();
  await expect(page.getByText("BusyBoy dev", { exact: true })).toHaveCount(0);
  await expect(page.getByText("BusyBoy 0.0.0", { exact: true })).toHaveCount(0);
});

test("removing a project in settings should keep its folder", async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web"], {
    claude: "signed-in",
  });
  folders.push(home, ...Object.values(projects).map((path) => dirname(path)));
  await openSettings(page);
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Projects" })
    .click();

  await page
    .getByRole("list", { name: "Projects" })
    .getByRole("button", { name: "Remove web" })
    .click();

  await expect(page.getByRole("list", { name: "Projects" })).toHaveCount(0);
  await expect(page.getByText("No projects yet.")).toHaveCount(0);
  expect(existsSync(join(projects.web, ".git"))).toBe(true);
});

test("opening settings before setup is finished should open setup", async ({
  page,
  context,
  baseURL,
}) => {
  folders.push(await useTestHome(context, baseURL!, { claude: "signed-in" }));

  await page.goto("/settings");

  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Sign in to an agent" })).toBeVisible();
});

async function openProjects(page: Page) {
  await openSettings(page);
  await page.getByRole("link", { name: "Projects" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
}

test("adding a folder that is not a git repository should show an error", async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web"]);
  folders.push(home, ...Object.values(projects).map((path) => dirname(path)));
  const folder = createTempFolder("plain");
  folders.push(folder);

  await openProjects(page);
  await page.getByLabel("Folder path").fill(folder);
  await page.getByRole("button", { name: "Add folder" }).click();

  await expect(page.getByRole("alert").filter({ hasText: folder })).toHaveText(
    `${folder} is not a git repository. Run git init there, or choose another folder.`,
  );
  await expect(page.getByRole("list", { name: "Projects" }).getByText("plain")).toHaveCount(0);
});

test("adding a folder named @scope should add the project", async ({ page, context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web"]);
  folders.push(home, ...Object.values(projects).map((path) => dirname(path)));
  const repository = createGitRepository("@scope");
  folders.push(dirname(repository));

  await openProjects(page);
  await page.getByLabel("Folder path").fill(repository);
  await page.getByRole("button", { name: "Add folder" }).click();

  await expect(
    page.getByRole("list", { name: "Projects" }).getByText("scope", { exact: true }),
  ).toBeVisible();
});

test("choosing folders in the desktop picker should add them as projects", async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web"]);
  folders.push(home, ...Object.values(projects).map((path) => dirname(path)));
  const picked = [createGitRepository("api"), createGitRepository("site")];
  folders.push(...picked.map((path) => dirname(path)));
  await page.addInitScript((paths) => {
    Object.assign(window, {
      busyboyDesktop: { pickFolders: async () => paths, pathForFile: () => "" },
    });
  }, picked);

  await openProjects(page);
  await page.getByRole("button", { name: "Choose folders…" }).click();

  const list = page.getByRole("list", { name: "Projects" });
  await expect(list).toContainText("api");
  await expect(list).toContainText("site");
});
