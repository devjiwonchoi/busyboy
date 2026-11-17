import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";

const ALLOWED = new Set(["Add attachment", "Dictate", "Send", "Stop"]);

async function openChat(page: Page) {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
}

async function actionNames(page: Page) {
  const composer = page
    .getByRole("region", { name: "Chat" })
    .locator('[data-slot="chat-composer"]');
  return composer
    .locator('[data-slot="composer-actions"] button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
}

test("the composer should show only attach and send, and Settings should change the harness", async ({
  page,
  context,
  baseURL,
}) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"], {
    claude: "signed-in",
    codex: "signed-in",
  });
  await openChat(page);

  const composer = page
    .getByRole("region", { name: "Chat" })
    .locator('[data-slot="chat-composer"]');
  const names = await actionNames(page);
  expect(names).toContain("Add attachment");
  expect(names).toContain("Send");
  expect(names).not.toContain("Stop");
  for (const name of names) expect(ALLOWED.has(name ?? "")).toBe(true);
  await expect(page.getByRole("group", { name: "Suggested replies" })).toHaveCount(0);
  await expect(page.getByRole("radiogroup", { name: "Harness" })).toHaveCount(0);
  await expect(page.getByLabel("Model")).toHaveCount(0);
  await expect(page.getByLabel("Effort")).toHaveCount(0);

  const textbox = composer.getByRole("textbox", { name: "Message" });
  const attach = composer.getByRole("button", { name: "Add attachment" });
  const send = composer.getByRole("button", { name: "Send" });
  await expect(send).toBeDisabled();
  await textbox.blur();

  const box = await composer.boundingBox();
  const field = await textbox.boundingBox();
  const plus = await attach.boundingBox();
  const submit = await send.boundingBox();
  expect(box && field && plus && submit).toBeTruthy();
  if (!box || !field || !plus || !submit) return;

  const placeholder = await textbox.evaluate((element) => {
    const before = getComputedStyle(element, "::before");
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + Number.parseFloat(before.left),
      y: rect.top + Number.parseFloat(before.top),
      paddingLeft: Number.parseFloat(getComputedStyle(element).paddingLeft),
    };
  });
  expect(placeholder.x - box.x).toBeGreaterThanOrEqual(0);
  expect(placeholder.x - box.x).toBeLessThanOrEqual(16);
  expect(Math.abs(placeholder.x - (field.x + placeholder.paddingLeft))).toBeLessThanOrEqual(1);
  expect(placeholder.y - field.y).toBeLessThanOrEqual(12);

  expect(plus.y).toBeGreaterThanOrEqual(field.y + field.height - 1);
  expect(Math.abs(plus.y - submit.y)).toBeLessThanOrEqual(4);
  expect(plus.x - box.x).toBeLessThanOrEqual(16);
  expect(submit.x).toBeGreaterThan(plus.x + plus.width);
  expect(box.x + box.width - (submit.x + submit.width)).toBeLessThanOrEqual(16);
  expect(box.height).toBeGreaterThan(56);
  expect(box.height).toBeLessThan(160);

  await expect(composer).toHaveScreenshot("empty-composer.png", {
    animations: "disabled",
    caret: "hide",
  });

  await textbox.fill("Hello");
  await expect(send).toBeEnabled();

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  const harness = page.getByRole("region", { name: "Harness" });
  await expect(harness.getByRole("radio", { name: "Use Claude Code by default" })).toBeChecked();
  await expect(harness.getByRole("radio", { name: "Use Codex by default" })).toBeEnabled();
  await expect(harness.getByRole("radio", { name: "Use Grok by default" })).toBeVisible();
  await harness.getByRole("radio", { name: "Use Codex by default" }).click();
  await expect(harness.getByRole("radio", { name: "Use Codex by default" })).toBeChecked();
  await expect
    .poll(() => JSON.parse(readFileSync(join(home, "app-settings.json"), "utf8")).defaultProvider)
    .toBe("codex");

  await page.getByRole("link", { name: "Back to chat" }).click();
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
  await expect(page.getByRole("radiogroup", { name: "Harness" })).toHaveCount(0);
  await expect(page.getByLabel("Model")).toHaveCount(0);
  await expect(page.getByLabel("Effort")).toHaveCount(0);
  const again = await actionNames(page);
  expect(again).toContain("Add attachment");
  expect(again).toContain("Send");
  for (const name of again) expect(ALLOWED.has(name ?? "")).toBe(true);
});
