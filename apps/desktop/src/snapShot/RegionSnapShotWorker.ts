// Runs as an Electron utility process so the native screenshot call cannot crash
// or stall the main process; `process.parentPort` is its channel to the app.
import type { RegionSnapShotRequest, RegionSnapShotResult } from "./RegionSnapShot.ts";

const parentPort = (
  process as {
    readonly parentPort?: {
      once(event: "message", listener: (event: { readonly data: unknown }) => void): void;
      postMessage(message: unknown): void;
    };
  }
).parentPort;

const send = (message: unknown) => parentPort?.postMessage(message);

async function capture() {
  const imported = await import("@crowecawcaw/xa11y");
  const xa11y = (imported as unknown as { readonly default?: typeof imported }).default ?? imported;
  send("ready");
  const request = await new Promise<RegionSnapShotRequest>((resolve) => {
    parentPort?.once("message", (event) => resolve(event.data as RegionSnapShotRequest));
  });
  const shot = await xa11y.screenshot({ region: request.region });
  const result: RegionSnapShotResult = {
    type: "result",
    width: shot.width,
    height: shot.height,
    png: shot.toPng().toString("base64"),
  };
  send(result);
}

void capture().catch((error: unknown) =>
  send({
    type: "error",
    message: error instanceof Error ? error.message : "Windows window capture failed.",
  } satisfies RegionSnapShotResult),
);
