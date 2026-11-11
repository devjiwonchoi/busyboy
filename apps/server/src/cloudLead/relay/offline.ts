// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import type * as Http from "node:http";
import * as Path from "node:path";

export type OfflineThread = { tokenSha256: string; threadId: string; taskId: string; role: string };
export type OfflineModel = { model: string; effort?: string; providerInstanceId: string };
export type OfflineKit = {
  threads: OfflineThread[];
  processes: Array<{ id: string; threadId: string }>;
  specs: Record<
    string,
    {
      current: {
        spec: {
          todos: Array<{ id: string; done: boolean }>;
          criteria: Array<{ id: string; evidence: unknown }>;
        };
      } | null;
    }
  >;
  /** Per task, the Claude model for each step; null where the step is not on Claude. */
  models: Record<
    string,
    Partial<Record<"plan" | "review" | "implement" | "fix", OfflineModel | null>>
  >;
  tools: unknown[];
};
export type JournalEntry = {
  seq: number;
  at: number;
  kind: string;
  threadId: string;
  taskId: string;
  tool?: string;
  args?: Record<string, unknown>;
  child?: Record<string, unknown>;
};

// The disk journal and kit survive a stopped sandbox and a fresh relay process.
export class OfflineRelay {
  readonly entries: JournalEntry[];
  kit: OfflineKit;
  appliedSeq: number;
  readonly directory: string;
  private readonly now: () => number;
  constructor(
    directory: string,
    now: () => number,
    log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  ) {
    this.directory = directory;
    this.now = now;
    Fs.mkdirSync(directory, { recursive: true });
    const journal = Path.join(directory, "journal.jsonl");
    if (Fs.existsSync(journal)) {
      const contents = Fs.readFileSync(journal, "utf8");
      if (contents.length > 0 && !contents.endsWith("\n")) {
        Fs.appendFileSync(journal, "\n");
      }
    }
    this.entries = Fs.existsSync(journal)
      ? Fs.readFileSync(journal, "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch (error) {
              log(`Skipping invalid offline journal line: ${String(error)}`);
              return [];
            }
          })
      : [];
    const kit = Path.join(directory, "kit.json");
    this.kit = Fs.existsSync(kit)
      ? JSON.parse(Fs.readFileSync(kit, "utf8"))
      : { threads: [], processes: [], specs: {}, models: {}, tools: [] };
    const applied = Path.join(directory, "applied.json");
    this.appliedSeq = Fs.existsSync(applied) ? JSON.parse(Fs.readFileSync(applied, "utf8")).seq : 0;
  }
  get lastSeq() {
    return this.entries.at(-1)?.seq ?? 0;
  }
  get pendingAsk() {
    return this.entries.some((entry) => entry.seq > this.appliedSeq && entry.tool === "ask_user");
  }
  setKit(kit: OfflineKit) {
    const threads = new Map(this.kit.threads.map((thread) => [thread.tokenSha256, thread]));
    for (const thread of kit.threads) {
      threads.set(thread.tokenSha256, thread);
    }
    this.kit = { ...kit, threads: [...threads.values()] };
    Fs.writeFileSync(Path.join(this.directory, "kit.json"), JSON.stringify(this.kit));
  }
  removeChild(threadId: string) {
    this.kit.threads = this.kit.threads.filter((thread) => thread.threadId !== threadId);
    this.setKit(this.kit);
  }
  isOfflineChild(authorization: string | undefined) {
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const hash = Crypto.createHash("sha256").update(bearer).digest("hex");
    return this.kit.threads.some(
      (thread) => thread.tokenSha256 === hash && thread.threadId.startsWith("offline-child:"),
    );
  }
  applied(seq: number) {
    this.appliedSeq = Math.max(seq, this.appliedSeq);
    Fs.writeFileSync(
      Path.join(this.directory, "applied.json"),
      JSON.stringify({ seq: this.appliedSeq }),
    );
  }
  /** Called after every append, so a connected Mac can apply the entry right away. */
  onAppend: () => void = () => {};
  append(entry: Omit<JournalEntry, "seq" | "at">) {
    const next = { ...entry, seq: this.lastSeq + 1, at: this.now() };
    Fs.appendFileSync(Path.join(this.directory, "journal.jsonl"), `${JSON.stringify(next)}\n`);
    this.entries.push(next);
    this.onAppend();
    return next.seq;
  }
  // Unknown wire messages stay held for the Mac, including older non-JSON clients.
  serve(
    request: { method: string; path: string; headers: Http.IncomingHttpHeaders; body: string },
    response: Http.ServerResponse,
    delegate: (thread: OfflineThread, args: Record<string, unknown>) => unknown,
  ): boolean {
    let rpc: {
      jsonrpc: string;
      id: unknown;
      method: string;
      params?: { name?: string; protocolVersion?: string; arguments?: Record<string, unknown> };
    } | null = null;
    if (request.method === "POST") {
      try {
        rpc = JSON.parse(Buffer.from(request.body, "base64").toString());
      } catch {
        return false;
      }
      if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
        return false;
      }
      if (
        !["initialize", "ping", "tools/list", "tools/call"].includes(rpc.method) &&
        !rpc.method.startsWith("notifications/")
      ) {
        return false;
      }
    }
    if (request.path.split("?")[0] !== "/mcp") {
      response.writeHead(403).end();
      return true;
    }
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const hash = Crypto.createHash("sha256")
      .update(bearer ?? "")
      .digest("hex");
    const thread = this.kit.threads.find((item) => item.tokenSha256 === hash);
    if (!thread) {
      response.writeHead(401).end();
      return true;
    }
    if (request.method === "GET") {
      response.writeHead(405).end();
      return true;
    }
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return true;
    }
    if (!rpc) {
      return false;
    }
    if (rpc.method.startsWith("notifications/") && rpc.id === undefined) {
      response.writeHead(202).end();
      return true;
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    let result: unknown = {};
    if (rpc.method === "initialize") {
      headers["mcp-session-id"] = Crypto.randomUUID();
      result = {
        protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "BusyBoy offline relay", version: "1" },
      };
    } else if (rpc.method === "tools/list") {
      result = { tools: this.kit.tools };
    } else if (rpc.method === "tools/call") {
      const tool = String(rpc.params?.name);
      const args = rpc.params?.arguments ?? {};
      let value: unknown;
      let error = false;
      if (tool === "task_spec_read") {
        const taskId = typeof args.taskId === "string" ? args.taskId : thread.taskId;
        const snapshot = structuredClone(this.kit.specs[taskId] ?? null);
        value = snapshot;
        const spec = snapshot?.current?.spec;
        if (spec) {
          for (const entry of this.entries) {
            if (entry.seq <= this.appliedSeq || entry.kind !== "call" || entry.taskId !== taskId) {
              continue;
            }
            if (entry.tool === "task_todo_set") {
              for (const todo of spec.todos) {
                if (todo.id === entry.args?.todoId && typeof entry.args.done === "boolean") {
                  todo.done = entry.args?.done;
                }
              }
            } else if (entry.tool === "task_evidence_set") {
              for (const criterion of spec.criteria) {
                if (criterion.id === entry.args?.criterionId) {
                  criterion.evidence = entry.args?.evidence;
                }
              }
            }
          }
        }
      } else if (
        tool === "task_update" &&
        (Object.keys(args).some(
          (key) => !["note", "stage", "prUrl", "planSummary", "resultSummary"].includes(key),
        ) ||
          (args.stage !== undefined && args.stage !== "running" && args.stage !== "in_review"))
      ) {
        error = true;
        value =
          "The Mac is offline; task_update can only record a note, stage running or in_review, or a PR URL right now. Continue without it.";
      } else if (tool === "task_delegate") {
        value = delegate(thread, args);
        error = typeof value === "string";
      } else if (
        [
          "task_todo_set",
          "task_evidence_set",
          "task_update",
          "task_review_set",
          "task_ready",
          "link_pull_request",
          "memory_write",
          "ask_user",
        ].includes(tool)
      ) {
        const seq = this.append({
          kind: "call",
          threadId: thread.threadId,
          taskId: thread.taskId,
          tool,
          args,
        });
        value =
          tool === "ask_user"
            ? "Saved for the user. The Mac is offline: end your turn now. The answer arrives as a message once the Mac is back."
            : {
                offline: true,
                journalSeq: seq,
                note: "The Mac is offline. This call was saved and is applied when the Mac reconnects; its checks run then.",
              };
      } else {
        error = true;
        value = `${tool} needs the Mac, which is offline right now. Continue without it; the Mac catches up when it reconnects.`;
      }
      result = {
        content: [
          { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
        ],
        isError: error,
        ...(typeof value === "object" && value !== null ? { structuredContent: value } : {}),
      };
    }
    response.writeHead(200, headers).end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    return true;
  }
}
