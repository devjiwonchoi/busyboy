#!/usr/bin/env node

// Fails when a production dependency of the web, server or desktop app has no
// license notice. The release web build runs the same check while bundling;
// this runs it without a build so pull requests catch it early.
import { generateThirdPartyLicenseManifest } from "./lib/third-party-licenses.ts";

const root = new URL("../", import.meta.url);

const manifest = await generateThirdPartyLicenseManifest({
  configFile: new URL("third-party-licenses.config.json", root),
  packageManifests: [
    { bundle: "web", path: new URL("apps/web/package.json", root) },
    { bundle: "server", path: new URL("apps/server/package.json", root) },
    { bundle: "desktop", path: new URL("apps/desktop/package.json", root) },
  ],
});

console.log(`Third-party licenses OK (${String(manifest.entries.length)} entries).`);
