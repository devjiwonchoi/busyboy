import { expect, test, type Page } from "@playwright/test";

type FakeBridge = {
  ready: string | null;
  listeners: ((version: string) => void)[];
  installs: number;
};

async function fakeDesktop(page: Page, ready: string | null) {
  await page.addInitScript((readyVersion) => {
    const fake: FakeBridge = { ready: readyVersion, listeners: [], installs: 0 };
    Object.assign(window, {
      fakeUpdates: fake,
      busyboyDesktop: {
        pickFolders: async () => [],
        pathForFile: () => "",
        onFocus: () => () => {},
        readyUpdate: async () => fake.ready,
        onUpdateReady: (listener: (version: string) => void) => {
          fake.listeners.push(listener);
          return () => {};
        },
        installUpdate: async () => {
          fake.installs++;
        },
      },
    });
  }, ready);
}

const installs = (page: Page) =>
  page.evaluate(() => (window as unknown as { fakeUpdates: FakeBridge }).fakeUpdates.installs);

test("an update that finishes downloading should offer Restart to update, and pressing it should install it", async ({
  page,
}) => {
  await fakeDesktop(page, null);
  await page.goto("/");
  const button = page.getByRole("button", { name: "Restart to update" });
  await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
  await expect(button).toHaveCount(0);

  await page.evaluate(() => {
    for (const listener of (window as unknown as { fakeUpdates: FakeBridge }).fakeUpdates.listeners)
      listener("0.0.24");
  });
  await expect(button).toBeVisible();
  await button.hover();
  await expect(page.getByText("BusyBoy 0.0.24 is downloaded.")).toBeVisible();

  await button.click();
  await expect.poll(() => installs(page)).toBe(1);
  await expect(page.getByRole("button", { name: "Restarting…" })).toBeDisabled();
});

test("an update downloaded before the window opened should be offered at once", async ({
  page,
}) => {
  await fakeDesktop(page, "0.0.24");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Restart to update" })).toBeVisible();
});

test("a browser without the desktop app should not offer an update", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Chat" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart to update" })).toHaveCount(0);
});
