import { SHUTDOWN_DONE_MESSAGE, SHUTDOWN_MESSAGE } from "@/lib/server-shutdown";

type Handler = () => void | Promise<void>;

type ParentPort = {
  on: (event: "message", listener: (event: { data: unknown }) => void) => void;
  postMessage: (message: unknown) => void;
};

type State = { handlers: Set<Handler>; listening: boolean };

const stateKey = Symbol.for("busyboy.shutdown");
const state: State = ((globalThis as Record<symbol, unknown>)[stateKey] as State | undefined) ?? {
  handlers: new Set(),
  listening: false,
};
(globalThis as Record<symbol, unknown>)[stateKey] = state;

export function onServerShutdown(handler: Handler) {
  state.handlers.add(handler);
  return () => state.handlers.delete(handler);
}

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
