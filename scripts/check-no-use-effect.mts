import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === "scripts") continue;
      found.push(...filesUnder(path));
      continue;
    }
    if (/\.(?:tsx?|mts)$/.test(path)) found.push(path);
  }
  return found;
}

const failures: string[] = [];
for (const path of filesUnder("apps/web")) {
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!/\buseEffect\s*\(/.test(line)) return;
    failures.push(`${path}:${index + 1}: ${line.trim()}`);
  });
}

if (failures.length === 0) {
  console.log("Product code does not call useEffect.");
  process.exit(0);
}

console.error(
  "Do not sync state in an effect; compute it during render, handle the event, reset with a key, or subscribe with useSyncExternalStore. External setup goes in a ref callback that returns its cleanup (https://react.dev/learn/you-might-not-need-an-effect).",
);
for (const failure of failures) console.error(failure);
process.exit(1);
