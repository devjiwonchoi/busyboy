// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
import * as NodeFs from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

import { RELAY_FILES } from "./relaySource.generated.ts";

const SOURCES = ["session.ts", "wsServer.ts", "server.ts"] as const;

const render = (files: Record<string, string>) =>
  [
    "// Generated from relay/*.ts by relaySource.test.ts. Do not edit; run",
    "// `UPDATE_RELAY_SOURCE=1 npx vp test run src/cloudLead/relay/relaySource.test.ts`.",
    "// The packaged server has no .ts files on disk, so the relay is uploaded from these strings.",
    `export const RELAY_FILES: Readonly<Record<string, string>> = ${JSON.stringify(files, null, 2)};`,
    "",
  ].join("\n");

describe("relay source", () => {
  it("matches the relay files it is uploaded from", async () => {
    const files: Record<string, string> = {};
    for (const name of SOURCES) {
      files[name] = await NodeFs.readFile(new URL(`./${name}`, import.meta.url), "utf8");
    }
    if (process.env.UPDATE_RELAY_SOURCE === "1") {
      await NodeFs.writeFile(new URL("./relaySource.generated.ts", import.meta.url), render(files));
      return;
    }
    expect(RELAY_FILES).toEqual(files);
  });
});
