import { SHUTDOWN_DONE_MESSAGE, SHUTDOWN_MESSAGE } from "@/lib/server-shutdown";

type Handler = () => void | Promise<void>;

type ParentPort = {
  on: (event: "message", listener: (event: { data: unknown }) => void) => void;
  postMessage: (message: unknown) => void;
};

type State = { handlers: Set<Handler>; listening: boolean };

// On globalThis so instrumentation and route bundles share one set of handlers.
const stateKey = Symbol.for("busyboy.shutdown");
const state: State = ((globalThis as Record<symbol, unknown>)[stateKey] as State | undefined) ?? {
  handlers: new Set(),
  listening: false,
};
(globalThis as Record<symbol, unknown>)[stateKey] = state;

// On Windows the app terminates the server outright, so signal and exit hooks never run.
export function onServerShutdown(handler: Handler) {
  state.handlers.add(handler);
  return () => state.handlers.delete(handler);
}

// Only an Electron utility process has process.parentPort.
export function listenForShutdown() {
  const port = (process as { parentPort?: ParentPort }).parentPort;
  if (!port || state.listening) return;
  state.listening = true;
  port.on("message", ({ data }) => {
    if ((data as { type?: string } | null)?.type !== SHUTDOWN_MESSAGE) return;
    void Promise.allSettled([...state.handlers].map(async (handler) => handler())).then(() =>
      port.postMessage({ type: SHUTDOWN_DONE_MESSAGE }),
    );
  });
}
