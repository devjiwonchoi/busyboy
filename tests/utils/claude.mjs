#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.env.E2E_CLAUDE_MODE ?? "replay";
const tape = process.env.E2E_CLAUDE_TAPE;
const gatesFolder = process.env.E2E_CLAUDE_GATES;
const MAX_REPLAY_GAP_MS = 500;
const RECORDED_ACCOUNT = { email: "recorded@example.test", tokenSource: "recorded" };

if (!tape) fail("E2E_CLAUDE_TAPE is not set. Run the tests through e2e.config.ts.");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function userText(message) {
  const content = message.message?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function requestKey(message) {
  if (message.type === "control_request") return `control_request:${message.request?.subtype}`;
  if (message.type === "user") return `user:${userText(message)}`;
  return undefined;
}

function isTextDelta(message) {
  return (
    message.type === "stream_event" &&
    message.event?.type === "content_block_delta" &&
    message.event.delta?.type === "text_delta"
  );
}

function withRecordedAccount(message) {
  const response = message.response?.response;
  if (message.type !== "control_response" || !response?.account) return message;
  return {
    ...message,
    response: { ...message.response, response: { ...response, account: RECORDED_ACCOUNT } },
  };
}

let turn;
let textSeen = false;

async function gate(label) {
  if (!gatesFolder || turn === undefined) return;
  const folder = join(gatesFolder, encodeURIComponent(turn));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${label}.reached`), "");
  while (!existsSync(join(folder, `${label}.release`))) await sleep(50);
}

let output = Promise.resolve();

function send(message) {
  output = output.then(async () => {
    if (isTextDelta(message) && !textSeen) {
      textSeen = true;
      await gate("first-text");
    }
    if (message.type === "result") await gate("turn-end");
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  return output;
}

function startTurn(message) {
  if (message.type !== "user") return;
  turn = userText(message);
  textSeen = false;
}

function record() {
  const spawnId = randomUUID();
  const log = (from, message) =>
    appendFileSync(tape, `${JSON.stringify({ spawn: spawnId, at: Date.now(), from, message })}\n`);
  const child = spawn(process.env.E2E_CLAUDE_REAL ?? "claude", process.argv.slice(2), {
    stdio: ["pipe", "pipe", "inherit"],
  });
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      log("app", message);
      startTurn(message);
      child.stdin.write(`${line}\n`);
    })
    .on("close", () => child.stdin.end());
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const message = withRecordedAccount(JSON.parse(line));
    log("claude", message);
    void send(message);
  });
  child.on("exit", (code) => void output.then(() => process.exit(code ?? 1)));
}

function loadReplies() {
  const replies = new Map();
  const spawns = new Map();
  for (const line of readFileSync(tape, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (!entry.spawn) continue;
    spawns.set(entry.spawn, [...(spawns.get(entry.spawn) ?? []), entry]);
  }
  for (const entries of spawns.values()) {
    let current;
    for (const entry of entries) {
      const key = entry.from === "app" ? requestKey(entry.message) : undefined;
      if (key) {
        current = replies.has(key) ? undefined : { request: entry, messages: [] };
        if (current) replies.set(key, current);
        continue;
      }
      if (entry.from === "claude" && current) current.messages.push(entry);
    }
  }
  return replies;
}

function replay() {
  const replies = loadReplies();
  let incoming = Promise.resolve();
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      const key = requestKey(message);
      if (!key) return;
      const reply = replies.get(key);
      if (!reply)
        fail(`The Claude tape has no reply to ${key}. Re-record it with pnpm record:claude.`);
      incoming = incoming.then(async () => {
        startTurn(message);
        let previous = reply.request.at;
        for (const entry of reply.messages) {
          await sleep(Math.min(entry.at - previous, MAX_REPLAY_GAP_MS));
          previous = entry.at;
          const recorded = entry.message;
          const live =
            recorded.type === "control_response" && message.type === "control_request"
              ? {
                  ...recorded,
                  response: { ...recorded.response, request_id: message.request_id },
                }
              : recorded;
          await send(live);
        }
      });
    })
    .on("close", () => void incoming.then(() => process.exit(0)));
}

if (mode === "record") record();
else replay();
