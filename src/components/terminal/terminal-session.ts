import type { TerminalEvent } from "@/server/terminal";
import type { WorkingDirectory } from "@/server/working-directory";

export type StartedTerminal = {
  id: string;
  cwd: string;
  shell: string;
  task: WorkingDirectory["task"];
};

const endpoint = (id: string) => `/api/terminal/${encodeURIComponent(id)}`;

// The cwd override is only honored in test mode.
export async function startTerminal(
  { cols, rows, taskId }: { cols: number; rows: number; taskId: string | null },
  signal: AbortSignal,
) {
  const cwd = new URL(window.location.href).searchParams.get("cwd") ?? undefined;
  const response = await fetch("/api/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cols, rows, cwd, taskId }),
    signal,
  });
  const body = (await response.json()) as StartedTerminal | { error: string };
  if (!response.ok || "error" in body)
    throw new Error("error" in body ? body.error : `HTTP ${response.status}`);
  return body;
}

export async function followTerminal(
  id: string,
  signal: AbortSignal,
  onEvent: (event: TerminalEvent) => void,
) {
  const response = await fetch(endpoint(id), { signal, cache: "no-store" });
  if (!response.ok || !response.body)
    throw new Error(`Could not follow the terminal: HTTP ${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    pending += value;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line) onEvent(JSON.parse(line) as TerminalEvent);
      newline = pending.indexOf("\n");
    }
  }
}

export function createInputSender(id: string) {
  let queued = "";
  let sending = false;

  async function flush() {
    if (sending || !queued) return;
    sending = true;
    const input = queued;
    queued = "";
    try {
      await fetch(endpoint(id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
    } catch {
      // The server is gone; the output stream reports that to the panel.
    } finally {
      sending = false;
      void flush();
    }
  }

  return (data: string) => {
    queued += data;
    void flush();
  };
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  void fetch(endpoint(id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cols, rows }),
  }).catch(() => {});
}

export function killTerminal(id: string) {
  void fetch(endpoint(id), { method: "DELETE", keepalive: true }).catch(() => {});
}
