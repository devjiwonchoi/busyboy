import { expect, test } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";

test("opening the Director from the desktop bridge should focus the message box", async ({
  page,
  context,
  baseURL,
}) => {
  await useProjectsHome(context, baseURL!, []);
  await page.addInitScript(() => {
    const listeners: ((target: string) => void)[] = [];
    (window as unknown as Record<string, unknown>).busyboyDesktop = {
      pickFolders: async () => [],
      pathForFile: () => "",
      onFocus: (listener: (target: string) => void) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    };
    (window as unknown as Record<string, unknown>).sendFocus = (target: string) =>
      listeners.forEach((listener) => listener(target));
  });
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.getByRole("textbox", { name: "Message" })).not.toBeFocused();

  await page.evaluate(() =>
    (window as unknown as { sendFocus: (target: string) => void }).sendFocus("director"),
  );

  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
});
