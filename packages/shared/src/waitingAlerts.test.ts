import { expect, it } from "vite-plus/test";
import { createWaitingAlertGate, waitingItemKeys } from "./waitingAlerts.js";
import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";

function snapshot(keys: string[]) {
  return new Map([["local", new Set(keys)]]);
}

it("ignores initial items, coalesces arrivals, defers cooldown arrivals and ignores decreases", () => {
  let now = 0;
  const gate = createWaitingAlertGate({ coalesceMs: 3000, cooldownMs: 30000, now: () => now });
  expect(gate.update(snapshot(["initial"]))).toBeNull();
  expect(gate.flush()).toBe(false);
  gate.update(snapshot(["a"]));
  now = 1000;
  gate.update(snapshot(["a", "b"]));
  now = 2000;
  expect(gate.update(snapshot(["a", "b", "c"]))).toBe(5000);
  now = 4999;
  expect(gate.flush()).toBe(false);
  now = 5000;
  expect(gate.flush()).toBe(true);
  now = 6000;
  expect(gate.update(snapshot(["a", "b", "c", "d"]))).toBe(35000);
  now = 34999;
  expect(gate.flush()).toBe(false);
  now = 35000;
  expect(gate.flush()).toBe(true);
  expect(gate.flush()).toBe(false);
  expect(gate.update(snapshot(["a"]))).toBeNull();
  expect(gate.update(snapshot(["a", "d"]))).toBe(65000);
  now = 65000;
  expect(gate.flush()).toBe(true);
});

it("alerts when the same waiting thread reappears after being answered", () => {
  let now = 0;
  const gate = createWaitingAlertGate({ coalesceMs: 3000, cooldownMs: 30000, now: () => now });
  expect(gate.update(snapshot([]))).toBeNull();
  expect(gate.update(snapshot(["thread:local:repeat"]))).toBe(3000);
  now = 3000;
  expect(gate.flush()).toBe(true);
  expect(gate.update(snapshot([]))).toBeNull();
  now = 33000;
  expect(gate.update(snapshot(["thread:local:repeat"]))).toBe(36000);
  now = 36000;
  expect(gate.flush()).toBe(true);
});

it("cancels attention when the coalesced items have already been handled", () => {
  let now = 0;
  const gate = createWaitingAlertGate({ coalesceMs: 3000, cooldownMs: 30000, now: () => now });
  gate.update(snapshot([]));
  gate.update(snapshot(["a"]));
  gate.update(snapshot([]));
  now = 3000;
  expect(gate.flush()).toBe(false);
});

it("baselines late-loading environments but alerts for new items after reconnect", () => {
  let now = 0;
  const gate = createWaitingAlertGate({ coalesceMs: 3000, cooldownMs: 30000, now: () => now });
  expect(gate.update(new Map())).toBeNull();
  expect(gate.update(new Map([["a", new Set(["card:a:existing"])]]))).toBeNull();
  const loaded = new Map([
    ["a", new Set(["card:a:existing"])],
    ["b", new Set(["card:b:existing"])],
  ]);
  expect(gate.update(loaded)).toBeNull();
  expect(gate.update(new Map([["b", loaded.get("b")!]]))).toBeNull();
  loaded.get("a")!.add("card:a:new");
  expect(gate.update(loaded)).toBe(3000);
  now = 3000;
  expect(gate.flush()).toBe(true);
  expect(gate.flush()).toBe(false);
});

it("counts only open cards and stable environment-scoped waiting threads", () => {
  const summary = {
    decisionCards: [
      { item: { id: "open", answeredAt: null, supersededAt: null } },
      { item: { id: "answered", answeredAt: "today", supersededAt: null } },
      { item: { id: "superseded", answeredAt: null, supersededAt: "today" } },
    ],
    waitingThreads: [{ threadId: "thread" }],
  } as unknown as ProjectTeamAttentionSummary;
  const result = waitingItemKeys([
    { environmentId: "local", summary },
    { environmentId: "remote", summary },
  ]);
  expect(result.total).toBe(4);
  expect([...result.keys]).toEqual([
    "card:local:open",
    "thread:local:thread",
    "card:remote:open",
    "thread:remote:thread",
  ]);
});

it("leaves snoozed cards out of the waiting count and alerts", () => {
  const item = (id: string, snoozedAt: string | null) => ({
    item: { id, answeredAt: null, supersededAt: null, snoozedAt },
  });
  const summary = {
    decisionCards: [item("open", null), item("later", "2026-11-11T00:00:00.000Z")],
    waitingThreads: [],
  } as unknown as ProjectTeamAttentionSummary;
  const { keys, total } = waitingItemKeys([{ environmentId: "local", summary }]);
  expect(total).toBe(1);
  expect([...keys]).toEqual(["card:local:open"]);
});
