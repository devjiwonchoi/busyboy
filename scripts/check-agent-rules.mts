import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { diffFromMergeBase } from "./git-text.mts";

const SHADCN_VERSION = "4.23.0";
const repoRoot = join(import.meta.dirname, "..");
const webRoot = join(repoRoot, "apps", "web");

const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const toolFiles = new Set(["README.md", "AGENTS.md", "pull_request_template.md"]);
const allowedMarkdown = new Set(["AGENTS.md", ".github/pull_request_template.md"]);

export function segmentIsKebab(segment: string): boolean {
  if (toolFiles.has(segment)) return true;
  if (/^\([a-z0-9]+(?:-[a-z0-9]+)*\)$/.test(segment)) return true;
  if (/^@[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)) return true;
  if (/^\[(?:\.\.\.)?[a-z0-9]+(?:-[a-z0-9]+)*\]$/.test(segment)) return true;
  if (/^\[\[\.\.\.[a-z0-9]+(?:-[a-z0-9]+)*\]\]$/.test(segment)) return true;
  if (/^\(\.{1,3}\)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)) return true;
  const bare = segment.startsWith(".") ? segment.slice(1) : segment;
  if (!bare) return false;
  return bare.split(".").every((part) => kebab.test(part));
}

export function pathIsKebab(file: string): boolean {
  return file.split("/").every((segment) => segment.length > 0 && segmentIsKebab(segment));
}

function suggestedName(file: string): string {
  return file
    .split("/")
    .map((segment) =>
      segment
        .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replaceAll(/[\s_]+/g, "-")
        .toLowerCase(),
    )
    .join("/");
}

function pathsOf(line: string): { status: string; paths: string[] } | null {
  if (!line) return null;
  const parts = line.split("\t");
  return { status: parts[0] ?? "", paths: parts.slice(1) };
}

const PALETTES =
  "zinc|neutral|gray|slate|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|stone";
const PALETTE_CLASS = new RegExp(
  `\\b((?:[a-z0-9-]+:)*(?:bg-|text-|border-|from-|to-|via-|fill-|stroke-|outline-|ring-|decoration-|divide-|placeholder-|shadow-|caret-)?(?:${PALETTES})-\\d{2,3}(?:\\/\\d{1,3})?)\\b`,
  "g",
);
const ARBITRARY_CLASS = /(?:^|\s)((?:[a-z0-9_-]+:)*[a-z0-9_-]+-\[[^\]]+\]|\[[a-z-]+:[^\]]+\])/g;

function quotedStrings(line: string): string[] {
  const found: string[] = [];
  const pattern = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;
  for (const match of line.matchAll(pattern)) found.push(match[0].slice(1, -1));
  return found;
}

function classViolations(file: string): string[] {
  const failures: string[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const text of quotedStrings(line)) {
      const tokens = new Set<string>();
      for (const match of text.matchAll(PALETTE_CLASS)) tokens.add(match[1] ?? "");
      for (const match of text.matchAll(ARBITRARY_CLASS)) tokens.add((match[1] ?? "").trim());
      for (const token of tokens) {
        if (!token) continue;
        failures.push(
          `${file}:${index + 1}: ${token}. Use a token class or a shadcn component variant.`,
        );
      }
    }
  });
  return failures;
}

function productFiles(): string[] {
  const found: string[] = [];
  const uiDir = join(webRoot, "components", "ui");
  function walk(directory: string) {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        if (path === uiDir) continue;
        if (
          directory === webRoot &&
          (entry === "node_modules" || entry === ".next" || entry === "scripts")
        ) {
          continue;
        }
        walk(path);
        continue;
      }
      if (/\.tsx?$/.test(path)) found.push(path);
    }
  }
  walk(webRoot);
  return found;
}

function shadcnVersionFailure(): string | null {
  const manifest = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const pinned = manifest.devDependencies?.shadcn;
  if (pinned !== SHADCN_VERSION) {
    return `apps/web/package.json has shadcn ${pinned ?? "missing"}. Pin it to ${SHADCN_VERSION} so the registry check uses that CLI.`;
  }
  return null;
}

function presetInvocation(): { code: string; base: string } {
  const config = JSON.parse(readFileSync(join(webRoot, "components.json"), "utf8")) as {
    style?: string;
    iconLibrary?: string;
    menuColor?: string;
    menuAccent?: string;
    tailwind?: { baseColor?: string };
  };
  const styleName = config.style ?? "base-mira";
  const dash = styleName.indexOf("-");
  const base = dash === -1 ? "radix" : styleName.slice(0, dash);
  const style = dash === -1 ? styleName : styleName.slice(dash + 1);
  const color = config.tailwind?.baseColor ?? "neutral";
  const payload = {
    menuColor: config.menuColor ?? "default",
    menuAccent: config.menuAccent ?? "subtle",
    radius: "default",
    font: "inter",
    iconLibrary: config.iconLibrary ?? "lucide",
    theme: color,
    baseColor: color,
    style,
    chartColor: color,
    fontHeading: "inherit",
  };
  const script = `import { encodePreset } from "shadcn/preset"; process.stdout.write(encodePreset(${JSON.stringify(payload)}));`;
  const code = execFileSync("node", ["--input-type=module", "--eval", script], {
    cwd: webRoot,
    encoding: "utf8",
  }).trim();
  return { code, base };
}

function runShadcn(args: string[]) {
  execFileSync("pnpm", ["exec", "shadcn", ...args], {
    cwd: webRoot,
    env: { ...process.env, CI: "1" },
    stdio: "pipe",
  });
}

function designSystemFailures(): string[] {
  const version = shadcnVersionFailure();
  if (version) return [version];
  const failures: string[] = [];
  for (const file of productFiles()) failures.push(...classViolations(file));
  const { code, base } = presetInvocation();
  const initCommand = `pnpm dlx shadcn@${SHADCN_VERSION} init --preset ${code} --base ${base} --force --yes --reinstall --no-monorepo`;
  const temp = mkdtempSync(join(tmpdir(), "busyboy-shadcn-"));
  cpSync(webRoot, temp, {
    recursive: true,
    filter: (source) => {
      const rel = relative(webRoot, source);
      if (!rel) return true;
      const top = rel.split(sep)[0] ?? "";
      return top !== "node_modules" && top !== ".next";
    },
  });
  symlinkSync(join(webRoot, "node_modules"), join(temp, "node_modules"));
  writeFileSync(join(temp, "app", "globals.css"), '@import "tailwindcss";\n');
  try {
    runShadcn([
      "init",
      "--preset",
      code,
      "--base",
      base,
      "--force",
      "--yes",
      "--reinstall",
      "--silent",
      "--no-monorepo",
      "--cwd",
      temp,
    ]);
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    return [
      ...failures,
      `shadcn init failed, so globals.css could not be checked. ${stderr.trim()}\nDo not edit globals.css by hand; regenerate it with ${initCommand}.`,
    ];
  }
  const generatedCss = readFileSync(join(temp, "app", "globals.css"), "utf8");
  const currentCss = readFileSync(join(webRoot, "app", "globals.css"), "utf8");
  if (generatedCss !== currentCss) {
    failures.push(
      `apps/web/app/globals.css differs from shadcn init. Do not edit globals.css by hand; regenerate it with ${initCommand}.`,
    );
  }
  const uiDir = join(webRoot, "components", "ui");
  for (const entry of readdirSync(uiDir)) {
    if (!entry.endsWith(".tsx")) continue;
    const name = entry.slice(0, -".tsx".length);
    try {
      runShadcn(["add", name, "--overwrite", "--yes", "--silent", "--cwd", temp]);
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
      failures.push(
        `components/ui/${entry} could not be regenerated. ${stderr.trim()}\nDo not edit it by hand; run pnpm dlx shadcn@${SHADCN_VERSION} add ${name} --overwrite in apps/web.`,
      );
      continue;
    }
    const generated = join(temp, "components", "ui", entry);
    execFileSync("pnpm", ["exec", "oxfmt", "--write", generated], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    if (readFileSync(generated, "utf8") !== readFileSync(join(uiDir, entry), "utf8")) {
      failures.push(
        `components/ui/${entry} differs from the shadcn registry. Do not edit it by hand; run pnpm dlx shadcn@${SHADCN_VERSION} add ${name} --overwrite in apps/web.`,
      );
    }
  }
  return failures;
}

function main() {
  const base = process.argv[2];
  if (!base) {
    console.error("Usage: node scripts/check-agent-rules.mts <base-ref>");
    process.exit(1);
  }

  const nameStatus = diffFromMergeBase(base, ["--name-status", "--find-renames"]);
  const failures: string[] = [];

  for (const line of nameStatus.split("\n")) {
    const entry = pathsOf(line);
    if (!entry) continue;
    if (entry.paths.includes("README.md")) {
      failures.push("README.md is maintained by its owner. Revert the README.md change.");
    }
    const added =
      entry.status.startsWith("A") || entry.status.startsWith("R") || entry.status.startsWith("C");
    if (!added) continue;
    const file = entry.paths[entry.paths.length - 1];
    if (!file) continue;
    if (!pathIsKebab(file)) {
      failures.push(
        `Rename "${file}" to kebab-case, for example "${suggestedName(file)}". Keep a tool-fixed name such as page.tsx, next.config.ts, README.md, or AGENTS.md.`,
      );
    }
    if (/\.(?:md|mdx|rst)$/.test(file) && !allowedMarkdown.has(file)) {
      failures.push(`Do not add "${file}". Put the note in the pull request description.`);
    }
  }

  failures.push(...designSystemFailures());

  const unique = [...new Set(failures)];
  if (unique.length === 0) {
    console.log(`Agent rules hold against ${base}.`);
    process.exit(0);
  }
  console.error(unique.join("\n\n"));
  process.exit(1);
}

if (process.argv[1]?.endsWith("check-agent-rules.mts")) main();
