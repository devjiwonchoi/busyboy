import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";
import { removeFolder, useTestHome } from "./support/test-home";

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
});

test("saving the always-ask list in settings should keep the page open and save it", async ({
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
    .getByRole("link", { name: "Approvals" })
    .click();
  const list = page.getByRole("textbox", { name: "Always-ask list" });
  await expect
    .poll(() =>
      list.evaluate((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps$")),
      ),
    )
    .toBe(true);

  await list.fill("Bash(vercel deploy*)");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("status")).toHaveText("Saved.");
  await expect(page).toHaveURL(/\/settings\?section=approvals$/);
  await expect.poll(() => readSettings(home).alwaysAsk).toEqual(["Bash(vercel deploy*)"]);
});

test("restoring the defaults after saving in settings should show the defaults again", async ({
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
    .getByRole("link", { name: "Approvals" })
    .click();
  const list = page.getByRole("textbox", { name: "Always-ask list" });
  await expect
    .poll(() =>
      list.evaluate((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps$")),
      ),
    )
    .toBe(true);
  await list.fill("Bash(vercel deploy*)");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");

  await page.getByRole("button", { name: "Restore defaults" }).click();

  await expect(page.getByRole("status")).toHaveText("Restored the defaults.");
  await expect(list).toHaveValue(/^Force push or delete a remote branch\n/);
  await expect.poll(() => readSettings(home).alwaysAsk).toBeNull();

  await list.fill("Bash(x*)");
  await expect(page.getByRole("status")).toHaveCount(0);
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

  await expect(page.getByText("No projects yet.")).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Pick a Director" })).toBeVisible();
});
