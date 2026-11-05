import {
  readAccessibleWindowContextWithApp,
  type SnapShotAccessibilityRequest,
} from "./SnapShotAccessibility.ts";

// Runs as an Electron utility process; `process.parentPort` is its channel to the app.
const parentPort = (
  process as {
    readonly parentPort?: {
      on(event: "message", listener: (event: { readonly data: unknown }) => void): void;
      postMessage(message: unknown): void;
    };
  }
).parentPort;

const send = (message: unknown) => parentPort?.postMessage(message);

const nextMessage = () =>
  new Promise<unknown>((resolve) => {
    parentPort?.on("message", (event) => resolve(event.data));
  });

async function readAccessibility() {
  const { App } = await import("@crowecawcaw/xa11y");
  send("ready");
  const request = (await nextMessage()) as SnapShotAccessibilityRequest;
  let started = false;
  const markStarted = () => {
    if (started) return;
    started = true;
    send("started");
  };
  const context = await readAccessibleWindowContextWithApp(App, request, markStarted).catch(
    () => undefined,
  );
  markStarted();
  send({ type: "result", context });
}

if (process.argv.includes("read")) {
  void readAccessibility().catch(() => send({ type: "result" }));
}
