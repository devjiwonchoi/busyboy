import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { COMPANIONS } from "@/server/companions";

import { createGitRepository, removeFolder, useTestHome } from "./support/test-home";

const folders: string[] = [];

test.afterEach(() => {
  for (const folder of folders.splice(0)) removeFolder(folder);
});

function readSettings(home: string) {
  return JSON.parse(readFileSync(join(home, "app-settings.json"), "utf8")) as {
    companion: string | null;
  };
}

const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });

test("a random director can be changed in settings and the sidebar updates", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const home = await useTestHome(context, baseURL!, { claude: "signed-in" });
  folders.push(home);
  const shop = createGitRepository("shop");
  const web = createGitRepository("web");
  folders.push(dirname(shop), dirname(web));
  await page.emulateMedia({ colorScheme: "dark" });

  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Sign in to an agent" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(chats(page)).toHaveAttribute("data-loaded", "true");
  const assigned = COMPANIONS.find((entry) => entry.id === readSettings(home).companion);
  expect(assigned).toBeTruthy();
  const director = chats(page).getByRole("link", { name: `${assigned!.name}, director` });
  await expect(director).toBeVisible();
  await expect(chats(page).getByText("Director", { exact: true })).toBeVisible();
  await expect(director.locator("[data-emoji]")).toHaveAttribute("data-emoji", assigned!.emoji);
  await expect(chats(page).getByRole("link").first()).toHaveAccessibleName(
    `${assigned!.name}, director`,
  );

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Projects" }).click();
  await page.getByLabel("Folder path").fill(shop);
  await page.getByRole("button", { name: "Add folder" }).click();
  await expect(page.getByRole("list", { name: "Projects" })).toContainText("shop");
  await page.getByLabel("Folder path").fill(web);
  await page.getByRole("button", { name: "Add folder" }).click();
  await expect(page.getByRole("list", { name: "Projects" })).toContainText("web");
  await page.getByRole("link", { name: "Back to chat" }).click();
  await expect(chats(page)).toHaveAttribute("data-loaded", "true");

  const form = page.getByRole("dialog", { name: "New manager" });
  await chats(page).getByRole("button", { name: "New manager" }).click();
  await form.getByRole("textbox", { name: "Name" }).fill("Webby");
  await form.getByRole("radio", { name: "shop" }).click();
  await form.getByRole("button", { name: "Create manager" }).click();
  await expect(form).toBeHidden();

  await chats(page).getByRole("button", { name: "New manager" }).click();
  await form.getByRole("textbox", { name: "Name" }).fill("Skills");
  await form.getByRole("radio", { name: "web" }).click();
  await form.getByRole("button", { name: "Create manager" }).click();
  await expect(form).toBeHidden();

  await chats(page).getByRole("button", { name: "New manager" }).click();
  await form.getByRole("textbox", { name: "Name" }).fill("Records");
  await form.getByRole("radio", { name: "Several projects" }).click();
  await form.getByRole("checkbox", { name: "shop" }).click();
  await form.getByRole("checkbox", { name: "web" }).click();
  await form.getByRole("button", { name: "Create room" }).click();
  await expect(form).toBeHidden();

  const webby = chats(page).getByRole("listitem", { name: "Webby" });
  await expect(webby.locator("[data-letter]")).toHaveAttribute("data-letter", "W");
  await expect(
    chats(page).getByRole("listitem", { name: "Skills" }).locator("[data-letter]"),
  ).toHaveAttribute("data-letter", "S");
  const room = chats(page).getByRole("listitem", { name: "Records" });
  await expect(room.locator("[data-letter]")).toHaveCount(2);
  await expect(chats(page).getByText(userInfo().username, { exact: true })).toBeVisible();
  await expect(chats(page).getByRole("link").first()).toHaveAccessibleName(
    `${assigned!.name}, director`,
  );

  await chats(page).getByRole("button", { name: "Search chats" }).click();
  await chats(page).getByRole("textbox", { name: "Search chats" }).fill("Skills");
  await expect(webby).toBeHidden();
  await expect(chats(page).getByRole("listitem", { name: "Skills" })).toBeVisible();
  await chats(page).getByRole("button", { name: "Search chats" }).click();
  await expect(webby).toBeVisible();

  const next = COMPANIONS.find((entry) => entry.id !== assigned!.id)!;
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Director", exact: true })).toBeVisible();
  await expect(
    page.getByRole("radio", { name: new RegExp(`^${assigned!.name} the`) }),
  ).toBeChecked();
  await page.getByRole("radio", { name: new RegExp(`^${next.name} the`) }).click();
  await expect.poll(() => readSettings(home).companion).toBe(next.id);
  await expect(page.getByRole("radio", { name: new RegExp(`^${next.name} the`) })).toBeChecked();
  await expect(page.locator("dd").filter({ hasText: next.name })).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: next.speech })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);

  await page.getByRole("link", { name: "Back to chat" }).click();
  await expect(chats(page)).toHaveAttribute("data-loaded", "true");
  await expect(chats(page).getByRole("link", { name: `${next.name}, director` })).toBeVisible();
  await expect(
    chats(page)
      .getByRole("link", { name: `${next.name}, director` })
      .locator("[data-emoji]"),
  ).toHaveAttribute("data-emoji", next.emoji);
  await expect(
    chats(page).getByRole("listitem", { name: "Webby" }).locator("[data-letter]"),
  ).toHaveAttribute("data-letter", "W");
  await expect(
    chats(page).getByRole("listitem", { name: "Records" }).locator("[data-letter]"),
  ).toHaveCount(2);
});
