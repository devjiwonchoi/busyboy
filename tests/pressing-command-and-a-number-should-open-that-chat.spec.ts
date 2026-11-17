import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";

function addManagers(home: string, managers: { id: string; name: string; project: string }[]) {
  const file = join(home, "app-settings.json");
  const settings = JSON.parse(readFileSync(file, "utf8")) as { managers?: unknown[] };
  const next = managers.map((manager, index) => ({
    ...manager,
    createdAt: new Date(index).toISOString(),
  }));
  writeFileSync(file, `${JSON.stringify({ ...settings, managers: next }, null, 2)}\n`);
}

async function openChat(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
  await expect(page.getByRole("navigation", { name: "Chats" })).toHaveAttribute(
    "data-loaded",
    "true",
  );
}

test("pressing command and a number should open that chat", async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ["zebra", "alpha", "middle"]);
  addManagers(home, [
    { id: "zebra", name: "Zebra", project: "zebra" },
    { id: "alpha", name: "Alpha", project: "alpha" },
    { id: "middle", name: "Middle", project: "middle" },
  ]);
  await openChat(page);
  const chats = page.getByRole("navigation", { name: "Chats" });
  const director = chats.getByRole("link", { name: "BusyBoy, director" });
  const box = page.getByRole("textbox", { name: "Message" });

  await box.click();
  await page.keyboard.type("1");
  await expect.poll(() => box.innerText()).toBe("1");

  await page.keyboard.press("ControlOrMeta+2");
  await expect(chats.getByRole("link", { name: "Zebra" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
    "aria-placeholder",
    "Message Zebra",
  );

  await page.keyboard.press("ControlOrMeta+4");
  await expect(chats.getByRole("link", { name: "Middle" })).toHaveAttribute("aria-current", "page");

  await page.keyboard.press("ControlOrMeta+1");
  await expect(director).toHaveAttribute("aria-current", "page");
  await expect.poll(() => page.getByRole("textbox", { name: "Message" }).innerText()).toBe("1");

  await page.getByRole("button", { name: "Search chats" }).click();
  await page.getByRole("textbox", { name: "Search chats" }).fill("alpha");
  await expect(chats.getByRole("listitem", { name: "Zebra" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+2");
  await expect(chats.getByRole("link", { name: "Alpha" })).toHaveAttribute("aria-current", "page");

  await page.keyboard.press("ControlOrMeta+9");
  await expect(chats.getByRole("link", { name: "Alpha" })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/manager=alpha/);
});
