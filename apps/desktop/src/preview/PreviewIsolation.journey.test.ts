// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Builds fixtures and drives a separate Electron process.
// User journey: a page in the preview pane is isolated from BusyBoy, and the pane still works.
// Builds the real guest preload, hosts a React page in a <webview> inside a real Electron window,
// and drives it the way the agent's preview tools and the element picker do.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { build } from "vite-plus";
import { assert, describe, it } from "vite-plus/test";

const directory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopRoot = NodePath.resolve(directory, "..", "..");
const require = NodeModule.createRequire(import.meta.url);
const webRequire = NodeModule.createRequire(
  NodePath.resolve(desktopRoot, "..", "web", "package.json"),
);

const bundle = async (input: {
  readonly entry: string;
  readonly outDir: string;
  readonly fileName: string;
  readonly format: "cjs" | "iife";
  readonly alias?: Record<string, string>;
}) => {
  await build({
    configFile: false,
    logLevel: "error",
    root: desktopRoot,
    mode: "development",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    resolve: { alias: input.alias ?? {} },
    build: {
      outDir: input.outDir,
      emptyOutDir: false,
      minify: false,
      target: "chrome130",
      lib: {
        entry: input.entry,
        formats: [input.format],
        name: "Journey",
        fileName: () => input.fileName,
      },
      rollupOptions: {
        external: (id: string) => id === "electron" || id.startsWith("node:"),
      },
    },
  });
};

const runElectron = (mainPath: string, config: object) =>
  new Promise<string>((resolve, reject) => {
    const electronPath = require("electron") as unknown as string;
    const child = NodeChildProcess.spawn(electronPath, [mainPath], {
      env: { ...process.env, JOURNEY_CONFIG: JSON.stringify(config), ELECTRON_ENABLE_LOGGING: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill(), 150_000);
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });

describe("preview pane isolation journey", () => {
  it(
    "keeps the preview working while the page cannot reach BusyBoy",
    { timeout: 240_000 },
    async () => {
      const workDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "busyboy-preview-journey-"),
      );
      try {
        const pageDir = NodePath.join(workDir, "page");
        await Promise.all([
          bundle({
            entry: NodePath.join(desktopRoot, "src", "preview-pick-preload.ts"),
            outDir: workDir,
            fileName: "preview-pick-preload.cjs",
            format: "cjs",
          }),
          bundle({
            entry: NodePath.join(directory, "journey", "electron-main.ts"),
            outDir: workDir,
            fileName: "electron-main.cjs",
            format: "cjs",
          }),
          bundle({
            entry: NodePath.join(directory, "journey", "page.ts"),
            outDir: pageDir,
            fileName: "page.js",
            format: "iife",
            alias: {
              "react-dom/client": webRequire.resolve("react-dom/client"),
              react: NodePath.dirname(webRequire.resolve("react/package.json")),
            },
          }),
        ]);
        NodeFS.writeFileSync(
          NodePath.join(pageDir, "index.html"),
          `<!doctype html><title>Journey</title><div id="root"></div><script src="/page.js"></script>`,
        );
        const hostPreload = NodePath.join(workDir, "host-preload.cjs");
        NodeFS.writeFileSync(
          hostPreload,
          `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("journey", { invoke: (channel) => ipcRenderer.invoke(channel) });\n`,
        );

        const output = await runElectron(NodePath.join(workDir, "electron-main.cjs"), {
          guestPreload: NodePath.join(workDir, "preview-pick-preload.cjs"),
          hostPreload,
          pageDir,
          userData: NodePath.join(workDir, "user-data"),
        });
        const line = output.split("\n").find((entry) => entry.startsWith("JOURNEY_RESULT "));
        assert.isDefined(line, `Electron printed no result:\n${output}`);
        const { results, error } = JSON.parse(line!.slice("JOURNEY_RESULT ".length)) as {
          results: Record<string, unknown>;
          error: string | null;
        };
        assert.isNull(error, `${error}\n${JSON.stringify(results, null, 2)}`);

        // The previewed page runs isolated from the preload, in the OS sandbox.
        assert.deepEqual(results["guestPreferences"], {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        });
        // The page's own world has no Electron or Node API...
        assert.deepEqual(results["pageWorld"], {
          require: "undefined",
          process: "undefined",
          ipcRenderer: "undefined",
          // ...only the passkey shim and the picker's React helper, copied in on purpose.
          passkeyShim: true,
          elementContextHelper: "function",
        });
        // The agent's evaluate and click still work on the page.
        assert.strictEqual(results["evaluate"], "Preview journey");
        assert.strictEqual(results["click"], "Count: 1");
        // The element picker still names the React component.
        assert.deepEqual(results["picked"], { tagName: "button", componentName: "Counter" });
        // Privileged IPC answers the app window and refuses a window showing a web page.
        assert.deepEqual(results["appWindowInvoke"], { value: "bearer-token" });
        assert.include(
          (results["webWindowInvoke"] as { error?: string }).error ?? "",
          "only available to the app window",
        );
      } finally {
        NodeFS.rmSync(workDir, { recursive: true, force: true });
      }
    },
  );
});
