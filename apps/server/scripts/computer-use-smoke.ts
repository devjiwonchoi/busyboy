#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off
//
// Manual check that the real Cua driver starts as Busyboy's private worker.
// It only reads: it lists apps and reports which macOS permissions the
// driver sees. Run it with Busyboy's Electron as Node, so the driver is
// attributed to the same app the backend runs under:
//
//   ELECTRON_RUN_AS_NODE=1 <Electron> apps/server/scripts/computer-use-smoke.ts \
//     apps/desktop/resources/cua-driver/cua-driver [host-bundle-id]
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  computerUseLauncherScript,
  createPrivateWorker,
} from "../src/computerUse/ComputerUseDriver.ts";

const [driverArg, hostBundleId = "dev.jiwon.busyboy"] = process.argv.slice(2);
if (!driverArg) {
  console.error("usage: computer-use-smoke.ts <cua-driver> [host-bundle-id]");
  process.exit(2);
}

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "computer-use-smoke-"));
const launcherPath = NodePath.join(directory, "cua-driver-launcher");
NodeFS.writeFileSync(
  launcherPath,
  computerUseLauncherScript({
    driverPath: NodePath.resolve(driverArg),
    driverHome: NodePath.join(directory, "driver-home"),
    keepDisplayAwake: false,
  }),
  { mode: 0o700 },
);

const worker = await createPrivateWorker({ launcherPath, hostBundleId });
try {
  const started = Date.now();
  const { apps } = await worker.listApps({});
  console.log(`listApps: ${apps.length} apps in ${Date.now() - started} ms`);
  console.log(`  frontmost: ${apps.find((app) => app.active)?.bundleId ?? "unknown"}`);
  const permissions = await worker.callTool("check_permissions", "{}");
  const report = JSON.parse(permissions.structuredJson ?? "{}");
  console.log("permissions:", {
    accessibility: report.accessibility,
    screenRecording: report.screen_recording,
    attribution: report.source?.attribution,
    hostBundleId: report.source?.host_bundle_id,
  });
} finally {
  await worker.shutdown();
  NodeFS.rmSync(directory, { recursive: true, force: true });
}
