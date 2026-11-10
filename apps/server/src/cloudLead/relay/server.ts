// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
/**
 * The relay that runs inside a cloud lead's sandbox (`node relay/server.ts`).
 *
 * One public port takes a single WebSocket from the Mac, authenticated by the
 * sandbox's random bearer in the first message. Over it the relay:
 * - runs the claude CLI and carries its stdin and stdout (channel "proc"), and
 * - forwards HTTP sent to 127.0.0.1:<mcp port> to the Mac's t3-code MCP
 *   endpoint (channel "http"), so the Mac server is never exposed.
 * Messages go through RelaySession, so a dropped WebSocket loses nothing.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import { RelaySession, type RelayLink, type RelayMessage } from "./session.ts";
import { acceptWebSocket } from "./wsServer.ts";

export interface RelayServerOptions {
  readonly token: string;
  readonly port: number;
  readonly mcpPort: number;
  readonly host?: string;
}

export interface RelayServer {
  readonly close: () => Promise<void>;
  /** Drops the current WebSocket, as a flaky network would. For tests. */
  readonly dropConnection: () => void;
  readonly port: () => number;
  readonly mcpPort: () => number;
}

const AUTH_TIMEOUT_MS = 5_000;

const tokensMatch = (expected: string, given: unknown): boolean => {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

export const startRelayServer = async (options: RelayServerOptions): Promise<RelayServer> => {
  const children = new Map<string, NodeChildProcess.ChildProcess>();
  const pendingHttp = new Map<string, NodeHttp.ServerResponse>();
  let currentLink: (RelayLink & { readonly drop: () => void }) | null = null;

  const session: RelaySession = new RelaySession({
    onMessage: (message) => handle(message),
  });

  const killGroup = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  };

  const handleProc = (message: RelayMessage) => {
    const id = String(message.id);
    if (message.op === "spawn") {
      const child = NodeChildProcess.spawn(String(message.cmd), message.args as string[], {
        cwd: message.cwd as string,
        // The sandbox's own environment (PATH, HOME) under what the Mac sent.
        env: { ...process.env, ...(message.env as NodeJS.ProcessEnv) },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      children.set(id, child);
      child.stdout?.on("data", (chunk: Buffer) =>
        session.send({ ch: "proc", op: "stdout", id, data: chunk.toString("base64") }),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        session.send({ ch: "proc", op: "stderr", id, data: chunk.toString("base64") }),
      );
      child.stdin?.on("error", () => {});
      child.on("error", (error) =>
        session.send({ ch: "proc", op: "error", id, message: error.message }),
      );
      child.on("exit", (code, signal) => {
        children.delete(id);
        session.send({ ch: "proc", op: "exit", id, code, signal });
        killGroup(child, "SIGKILL");
      });
      return;
    }
    const child = children.get(id);
    if (child === undefined) return;
    if (message.op === "stdin") child.stdin?.write(Buffer.from(String(message.data), "base64"));
    else if (message.op === "end") child.stdin?.end();
    else if (message.op === "kill") killGroup(child, (message.signal as NodeJS.Signals) ?? "SIGTERM");
  };

  const handleHttp = (message: RelayMessage) => {
    const response = pendingHttp.get(String(message.id));
    if (response === undefined) return;
    if (message.op === "head") {
      response.writeHead(Number(message.status), message.headers as NodeHttp.OutgoingHttpHeaders);
      response.flushHeaders();
    } else if (message.op === "chunk") {
      response.write(Buffer.from(String(message.data), "base64"));
    } else if (message.op === "end" || message.op === "error") {
      pendingHttp.delete(String(message.id));
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  };

  const handle = (message: RelayMessage) => {
    if (message.ch === "proc") handleProc(message);
    else if (message.ch === "http") handleHttp(message);
  };

  const ackTimer = setInterval(() => session.ack(), 1_000);
  ackTimer.unref();

  const publicServer = NodeHttp.createServer((request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 404).end();
  });
  publicServer.on("upgrade", (request, socket, head) => {
    const ws = acceptWebSocket(request, socket as never, head);
    if (ws === null) return;
    let authed = false;
    const link = {
      send: (line: string) => ws.send(line),
      close: () => ws.close(),
      drop: () => (socket as { destroy: () => void }).destroy(),
    };
    const authTimer = setTimeout(() => {
      if (!authed) ws.close();
    }, AUTH_TIMEOUT_MS);
    ws.onMessage = (line) => {
      if (!authed) {
        let frame: { t?: unknown; token?: unknown };
        try {
          frame = JSON.parse(line) as typeof frame;
        } catch {
          return ws.close();
        }
        if (frame.t !== "hello" || !tokensMatch(options.token, frame.token)) return ws.close();
        authed = true;
        clearTimeout(authTimer);
        currentLink = link;
        session.attach(link);
      }
      try {
        session.receive(link, line);
      } catch {
        ws.close();
      }
    };
    ws.onClose = () => {
      clearTimeout(authTimer);
      if (currentLink === link) currentLink = null;
      session.detach(link);
    };
  });

  let nextRequest = 0;
  const mcpServer = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const id = `r${++nextRequest}`;
      pendingHttp.set(id, response);
      session.send({
        ch: "http",
        op: "request",
        id,
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("base64"),
      });
      response.on("close", () => {
        if (pendingHttp.delete(id)) session.send({ ch: "http", op: "abort", id });
      });
    });
  });

  const listen = (server: NodeHttp.Server, port: number, host: string) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : port);
      });
    });

  const port = await listen(publicServer, options.port, options.host ?? "0.0.0.0");
  const mcpPort = await listen(mcpServer, options.mcpPort, "127.0.0.1");

  return {
    port: () => port,
    mcpPort: () => mcpPort,
    dropConnection: () => currentLink?.drop(),
    close: async () => {
      clearInterval(ackTimer);
      for (const child of children.values()) killGroup(child, "SIGKILL");
      currentLink?.close();
      await Promise.all(
        [publicServer, mcpServer].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    },
  };
};

const isEntry = process.argv[1]?.endsWith("relay/server.ts") === true;
if (isEntry) {
  const token = process.env.BUSYBOY_RELAY_TOKEN;
  if (token === undefined || token.length < 32) {
    process.stderr.write("BUSYBOY_RELAY_TOKEN is missing.\n");
    process.exit(2);
  }
  // Children must not inherit the bearer.
  delete process.env.BUSYBOY_RELAY_TOKEN;
  void startRelayServer({
    token,
    port: Number(process.env.BUSYBOY_RELAY_PORT ?? "8787"),
    mcpPort: Number(process.env.BUSYBOY_RELAY_MCP_PORT ?? "8788"),
  }).then((server) => {
    process.stdout.write(`relay listening on ${server.port()} (mcp ${server.mcpPort()})\n`);
  });
}
