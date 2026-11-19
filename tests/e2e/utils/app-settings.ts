import { writeFileSync } from "node:fs";
import { join } from "node:path";

function e2eHome() {
  const home = process.env.BUSYBOY_E2E_HOME;
  if (!home) throw new Error("BUSYBOY_E2E_HOME is not set. Run the tests through e2e.config.ts.");
  return home;
}

function writeAppSettings(settings: {
  setupCompletedAt: string | null;
  defaultProvider: string | null;
}) {
  writeFileSync(
    join(e2eHome(), "app-settings.json"),
    `${JSON.stringify({ version: 1, ...settings })}\n`,
  );
}

export function startAsFirstLaunch() {
  writeAppSettings({ setupCompletedAt: null, defaultProvider: null });
}

export function finishSetupWithClaude() {
  writeAppSettings({ setupCompletedAt: new Date().toISOString(), defaultProvider: "claude" });
}
