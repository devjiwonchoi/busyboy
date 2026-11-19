import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { startAsFirstLaunch } from "./utils/app-settings";

describe("first launch", () => {
  beforeEach(() => {
    startAsFirstLaunch();
  });

  test("opens setup", async ({ app, screen }) => {
    await app.open("/");

    await expect(screen.getByRole("heading", "Sign in to an agent")).toBeVisible();
  });
});
