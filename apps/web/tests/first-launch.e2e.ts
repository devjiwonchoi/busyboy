import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("a first launch opens setup", async ({ app, screen }) => {
  await app.open("/");
  await expect(screen.getByRole("heading", { name: "Sign in to an agent" })).toBeVisible();
});
