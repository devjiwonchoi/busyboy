import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const allowed = "src/hooks/use-external-sync.ts";

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path));
      continue;
    }
    if (/\.(?:tsx?|mts)$/.test(path)) found.push(path);
  }
  return found;
}

const failures: string[] = [];
for (const path of filesUnder("src")) {
  if (path === allowed) continue;
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
  "Do not sync state in an effect; compute it during render, handle the event, reset with a key, or subscribe with useSyncExternalStore. External setup goes through useExternalSync from src/hooks/use-external-sync.ts (https://react.dev/learn/you-might-not-need-an-effect).",
);
for (const failure of failures) console.error(failure);
process.exit(1);
