// @effect-diagnostics nodeBuiltinImport:off - Next's route handler runs outside the Effect runtime.
import { generateThirdPartyLicenseManifest } from "../../../../../scripts/lib/third-party-licenses";
import { resolve } from "node:path";

// Vite serves this generated manifest itself; the backend redirects dev assets here.
export async function GET() {
  const manifest = await generateThirdPartyLicenseManifest({
    configFile: resolve(process.cwd(), "../../third-party-licenses.config.json"),
    packageManifests: [
      { bundle: "web", path: resolve(process.cwd(), "package.json") },
      { bundle: "server", path: resolve(process.cwd(), "../server/package.json") },
      { bundle: "desktop", path: resolve(process.cwd(), "../desktop/package.json") },
    ],
    bundleName: "web",
    allowMissingGeneratedNotices: true,
  });
  return Response.json(manifest);
}
