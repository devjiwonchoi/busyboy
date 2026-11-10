import * as NodeOS from "node:os";
import type { HostMemoryPressure, HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()("t3/resourceTelemetry/HostResources") {}

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
}

function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat subtracts speculative pages from its printed "Pages free" count.
  // Adding them here counts each reclaimable page once; purgeable pages overlap.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parseDarwinMemoryPressure(output: string): HostMemoryPressure | null {
  switch (output.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return null;
  }
}

const SWAP_UNITS: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `sysctl vm.swapusage`, e.g. "vm.swapusage: total = 2048.00M  used = 698.00M  free = 1350.00M  (encrypted)". */
export function parseDarwinSwapUsage(
  output: string,
): { readonly totalBytes: number; readonly usedBytes: number } | null {
  const amount = (name: string) => {
    const match = new RegExp(`${name} = ([\\d.]+)([KMGT])`).exec(output);
    if (!match) return null;
    const bytes = Math.round(Number(match[1]) * SWAP_UNITS[match[2]!]!);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
  };
  const totalBytes = amount("total");
  const usedBytes = amount("used");
  if (totalBytes === null || usedBytes === null) return null;
  return { totalBytes, usedBytes: Math.min(usedBytes, totalBytes) };
}

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu();
    yield* Effect.sleep("200 millis");
    const cpu = readCpu();
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    const cpuUtilization =
      previousCpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null;
    const totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    let memoryPressure: HostMemoryPressure | undefined;
    let swap: { readonly totalBytes: number; readonly usedBytes: number } | undefined;
    if (platform === "linux") {
      const meminfo = yield* fs
        .readFileString("/proc/meminfo")
        .pipe(Effect.orElseSucceed(() => ""));
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
      if (available) availableMemoryBytes = Number(available) * 1024;
    } else if (platform === "darwin") {
      const output = yield* spawner
        .string(ChildProcess.make("/usr/bin/vm_stat", [], { stdin: "ignore", stderr: "ignore" }))
        .pipe(
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => ""),
        );
      availableMemoryBytes = darwinAvailableMemory(output) ?? availableMemoryBytes;
      const sysctl = (args: ReadonlyArray<string>) =>
        spawner
          .string(
            ChildProcess.make("/usr/sbin/sysctl", args, { stdin: "ignore", stderr: "ignore" }),
          )
          .pipe(
            Effect.timeout("1 second"),
            Effect.orElseSucceed(() => ""),
          );
      memoryPressure =
        parseDarwinMemoryPressure(yield* sysctl(["-n", "kern.memorystatus_vm_pressure_level"])) ??
        undefined;
      swap = parseDarwinSwapUsage(yield* sysctl(["vm.swapusage"])) ?? undefined;
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      ...(memoryPressure === undefined ? {} : { memoryPressure }),
      ...(swap === undefined
        ? {}
        : { swapUsedBytes: swap.usedBytes, swapTotalBytes: swap.totalBytes }),
    };
  });

  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  return HostResources.of({ read: Cache.get(cache, "host") });
});

export const layer = Layer.effect(HostResources, make());
