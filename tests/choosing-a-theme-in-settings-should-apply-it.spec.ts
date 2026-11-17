import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";

const themeOf = (home: string) =>
  (JSON.parse(readFileSync(join(home, "app-settings.json"), "utf8")) as { theme?: string }).theme;

async function openAppearance(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("link", { name: "Appearance" })
    .click();
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
}

test("choosing a theme in settings should apply it", async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"]);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveClass(/dark/);
  await expect(html).toHaveAttribute("data-theme", "dark");

  await openAppearance(page);
  await expect(page.getByRole("radio", { name: /^Dark/ })).toBeChecked();
  await page.screenshot({ path: "/opt/cursor/artifacts/theme-dark.png" });

  await page.getByRole("radio", { name: /^Light/ }).click({ force: true });
  await expect(html).not.toHaveClass(/dark/);
  await expect.poll(() => themeOf(home)).toBe("light");
  await page.reload();
  await expect(page.getByRole("radio", { name: /^Light/ })).toBeChecked();
  await expect(html).not.toHaveClass(/dark/);
  await page.screenshot({ path: "/opt/cursor/artifacts/theme-light.png" });

  await page.getByRole("radio", { name: /^System/ }).click({ force: true });
  await expect.poll(() => themeOf(home)).toBe("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html).not.toHaveClass(/dark/);
});
