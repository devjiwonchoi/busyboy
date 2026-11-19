#!/usr/bin/env node
import { createInterface } from "node:readline";

const REPLY =
  process.env.FAKE_CLAUDE_REPLY ??
  "Streaming reply one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen finished.";
const DELAY_MS = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 250);
const THINK_MS = Number(process.env.FAKE_CLAUDE_THINK_MS ?? 1500);
const SESSION_ID = "00000000-0000-4000-8000-000000000000";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let turns = 0;
let interrupted = false;
let queue = Promise.resolve();

async function reply() {
  const id = `msg_fake_${++turns}`;
  interrupted = false;
  write({ type: "system", subtype: "init", session_id: SESSION_ID, mcp_servers: [] });
  const event = (body) =>
    write({ type: "stream_event", event: body, session_id: SESSION_ID, parent_tool_use_id: null });
  event({ type: "message_start", message: { id } });
  await sleep(THINK_MS);
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const words = REPLY.split(" ");
  let text = "";
  for (const [index, word] of words.entries()) {
    if (interrupted) break;
    const piece = index === 0 ? word : ` ${word}`;
    text += piece;
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
    await sleep(DELAY_MS);
  }
  event({ type: "content_block_stop", index: 0 });
  event({ type: "message_stop" });
  write({
    type: "assistant",
    message: { id, role: "assistant", content: [{ type: "text", text }] },
    session_id: SESSION_ID,
    parent_tool_use_id: null,
  });
  write({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: SESSION_ID,
    ...(interrupted ? { terminal_reason: "aborted_streaming" } : {}),
  });
}

function answer(request_id, response = {}) {
  write({ type: "control_response", response: { subtype: "success", request_id, response } });
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    if (message.request?.subtype === "initialize") {
      answer(message.request_id, {
        commands: [],
        agents: [],
        output_style: "default",
        available_output_styles: ["default"],
        models: [],
        account: { email: "e2e@example.test", apiKeySource: "user", tokenSource: "none" },
      });
    } else {
      if (message.request?.subtype === "interrupt") interrupted = true;
      answer(message.request_id);
    }
  } else if (message.type === "user") {
    queue = queue.then(reply);
  }
}
await queue;
