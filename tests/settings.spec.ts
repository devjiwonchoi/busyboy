import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { APP_VERSION } from "@/lib/app-version";

import { useProjectsHome } from "./support/projects-home";
import {
  createGitRepository,
  createTempFolder,
  removeFolder,
  useTestHome,
} from "./support/test-home";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const folders: string[] = [];

test.afterEach(() => {
  for (const folder of folders.splice(0)) removeFolder(folder);
});

const readSettings = (home: string) =>
  JSON.parse(readFileSync(join(home, "app-settings.json"), "utf8"));

async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("main", { name: "Settings" })).toBeVisible();
}

test("settings should show the running version and the chat should not", async ({
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
  await expect(page.getByText(`BusyBoy ${APP_VERSION}`, { exact: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText(`BusyBoy ${APP_VERSION}`, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Projects" }).click();
  await expect(page.getByText(`BusyBoy ${APP_VERSION}`, { exact: true })).toBeVisible();
});

test("choosing a companion in settings should save it without a Continue button", async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web"], {
    claude: "signed-in",
  });
  folders.push(home, ...Object.values(projects).map((path) => dirname(path)));
  await openSettings(page);

  await page.getByRole("radio", { name: /^Ming the/ }).click();

  await expect.poll(() => readSettings(home).companion).toBe("ming");
  await expect(page.getByRole("radio", { name: /^Ming the/ })).toBeChecked();
  await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
  await expect(page.getByText(/Step \d of/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Approvals" })).toHaveCount(0);
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

test("choosing a picture over the size limit should show an error", async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web"]);
  folders.push(home, ...Object.values(projects).map((path) => dirname(path)));

  await openSettings(page);
  const large = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
  await page
    .getByLabel("Your own picture")
    .setInputFiles({ name: "large.png", mimeType: "image/png", buffer: large });
  await page.getByRole("button", { name: "Use picture" }).click();

  await expect(page.getByRole("alert").filter({ hasText: "picture" })).toHaveText(
    "Choose a picture under 900 KB.",
  );
  expect(existsSync(join(home, "app-companion-image.png"))).toBe(false);
});

test("setting a companion picture should show it in the director greeting", async ({
  page,
  context,
  baseURL,
}) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ["web"], {
    claude: "signed-in",
  });
  folders.push(home, ...Object.values(projects).map((path) => dirname(path)));

  await openSettings(page);
  await page.getByRole("radio", { name: /^Ming the/ }).click();
  await expect.poll(() => readSettings(home).companion).toBe("ming");
  await page
    .getByLabel("Your own picture")
    .setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Use picture" }).click();
  await expect(page.getByRole("button", { name: "Remove picture" })).toBeVisible();
  expect(readFileSync(join(home, "app-companion-image.png"))).toEqual(PNG);

  await page.getByRole("link", { name: "Back to chat" }).click();
  await expect(
    page.getByRole("region", { name: "Chat" }).locator('img[src^="/api/companion-image"]'),
  ).toBeVisible();
});
