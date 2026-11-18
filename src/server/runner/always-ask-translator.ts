import { resolve } from "node:path";

import {
  BUSYBOY_FILES_RULE,
  CONNECTOR_RULE,
  DEFAULT_BRANCH_RULE,
  DELETE_OUTSIDE_RULE,
  DEPLOY_RULE,
  FORCE_PUSH_RULE,
  ruleError,
  shellCommand,
  SUBAGENT_EDIT_RULE,
} from "./always-ask";

export type CodexPrefixRule = {
  pattern: string[];
  rule: string;
  justification: string;
};

export type TranslatedAskRules = {
  claude: string[];
  grok: string[];
  codex: CodexPrefixRule[];
};

export type AskMatch = { rule: string; remember: boolean };

type Entry = { rule: string; pattern: string; remember: boolean; harness: "claude" | "grok" };

// why: These are the publisher subcommands the deploy rule already treats as a publish, written as a prefix.
const DEPLOY_PREFIXES: string[][] = [
  ["vercel"],
  ["vc"],
  ["netlify", "deploy"],
  ["fly", "deploy"],
  ["flyctl", "deploy"],
  ["firebase", "deploy"],
  ["wrangler", "deploy"],
  ["wrangler", "publish"],
  ["wrangler", "pages", "deploy"],
  ["wrangler", "versions", "deploy"],
  ["npm", "publish"],
  ["pnpm", "publish"],
  ["cargo", "publish"],
  ["yarn", "publish"],
  ["yarn", "npm", "publish"],
  ["gem", "push"],
  ["docker", "push"],
  ["twine", "upload"],
  ["gh", "release", "create"],
  ["gh", "release", "upload"],
  ["gh", "release", "edit"],
  ["gh", "workflow", "run"],
  ["terraform", "apply"],
  ["terraform", "destroy"],
  ["terraform", "up"],
  ["terraform", "import"],
  ["tofu", "apply"],
  ["tofu", "destroy"],
  ["tofu", "up"],
  ["tofu", "import"],
  ["pulumi", "apply"],
  ["pulumi", "destroy"],
  ["pulumi", "up"],
  ["pulumi", "import"],
  ["kubectl", "apply"],
  ["kubectl", "create"],
  ["kubectl", "delete"],
  ["kubectl", "replace"],
  ["kubectl", "patch"],
  ["kubectl", "scale"],
  ["kubectl", "rollout"],
  ["kubectl", "set"],
  ["kubectl", "edit"],
  ["kubectl", "drain"],
  ["helm", "install"],
  ["helm", "upgrade"],
  ["helm", "uninstall"],
  ["helm", "rollback"],
  ["helm", "delete"],
  ["serverless", "deploy"],
  ["serverless", "remove"],
  ["sls", "deploy"],
  ["sls", "remove"],
  ["railway", "up"],
  ["railway", "deploy"],
  ["railway", "redeploy"],
  ["heroku", "releases:rollback"],
  ["heroku", "apps:destroy"],
  ["heroku", "pg:reset"],
  ["heroku", "run"],
  ["aws", "s3", "rm"],
  ["aws", "s3", "rb"],
  ["aws", "s3", "mv"],
  ["aws", "s3", "sync"],
  ["aws", "cloudformation", "deploy"],
  ["aws", "cloudformation", "delete-stack"],
];

const FORCE_PATTERNS = [
  "Bash(git push *--force*)",
  "Bash(git push *--force-with-lease*)",
  "Bash(git push *--force-if-includes*)",
  "Bash(git push *--mirror*)",
  "Bash(git push *--delete*)",
  "Bash(git push *-f*)",
  "Bash(git push *-d*)",
  "Bash(git push *+*)",
];

const GIT_PUSH = ["git", "push"];

const FILE_TOOLS: Record<string, "edit" | "read"> = {
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  read: "read",
};

const sameRule = (rule: string, builtIn: string) => rule.toLowerCase() === builtIn.toLowerCase();

const bashOf = (tokens: string[]) => `Bash(${tokens.join(" ")} *)`;

function starlarkString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function bashBody(rule: string) {
  const match = /^Bash\((.*)\)$/s.exec(rule);
  return match ? match[1] : null;
}

// why: Codex prefix rules are argv prefixes. A glob that is not a trailing star cannot be one.
export function bashToCodexPrefix(rule: string): string[] | null {
  const body = bashBody(rule);
  if (body === null) return null;
  let text = body.trim();
  if (text.endsWith(":*")) text = text.slice(0, -2).trimEnd();
  else if (text.endsWith("*")) text = text.slice(0, -1).trimEnd();
  if (!text || text.includes("*") || text.includes("?") || text.includes("[")) return null;
  const tokens = text.split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? tokens : null;
}

function privatePatterns(folder: string): Entry[] {
  const absolute = resolve(folder).split("\\").join("/");
  const claudeRoot = absolute.startsWith("/") ? `/${absolute}` : absolute;
  const rules = [
    { harness: "claude" as const, pattern: `Edit(${claudeRoot}/**)` },
    { harness: "claude" as const, pattern: `Read(${claudeRoot}/**)` },
    { harness: "grok" as const, pattern: `Edit(${absolute}/**)` },
    { harness: "grok" as const, pattern: `Read(${absolute}/**)` },
  ];
  return rules.map(({ harness, pattern }) => ({
    rule: BUSYBOY_FILES_RULE,
    pattern,
    remember: false,
    harness,
  }));
}

function entriesFor(rule: string): { claude: Entry[]; codex: CodexPrefixRule[] } {
  const text = rule.trim();
  if (
    sameRule(text, DELETE_OUTSIDE_RULE) ||
    sameRule(text, CONNECTOR_RULE) ||
    sameRule(text, SUBAGENT_EDIT_RULE) ||
    sameRule(text, BUSYBOY_FILES_RULE)
  ) {
    return { claude: [], codex: [] };
  }
  if (sameRule(text, FORCE_PUSH_RULE)) {
    return {
      claude: FORCE_PATTERNS.map((pattern) => ({
        rule: FORCE_PUSH_RULE,
        pattern,
        remember: true,
        harness: "claude" as const,
      })),
      codex: [{ pattern: GIT_PUSH, rule: FORCE_PUSH_RULE, justification: "" }],
    };
  }
  if (sameRule(text, DEFAULT_BRANCH_RULE)) {
    return {
      claude: [
        {
          rule: DEFAULT_BRANCH_RULE,
          pattern: "Bash(git push *)",
          remember: true,
          harness: "claude",
        },
      ],
      codex: [{ pattern: GIT_PUSH, rule: DEFAULT_BRANCH_RULE, justification: "" }],
    };
  }
  if (sameRule(text, DEPLOY_RULE)) {
    return {
      claude: DEPLOY_PREFIXES.map((tokens) => ({
        rule: DEPLOY_RULE,
        pattern: bashOf(tokens),
        remember: true,
        harness: "claude" as const,
      })),
      codex: DEPLOY_PREFIXES.map((pattern) => ({ pattern, rule: DEPLOY_RULE, justification: "" })),
    };
  }
  if (ruleError(text)) return { claude: [], codex: [] };
  const prefix = bashToCodexPrefix(text);
  return {
    claude: [{ rule: text, pattern: text, remember: true, harness: "claude" }],
    codex: prefix ? [{ pattern: prefix, rule: text, justification: "" }] : [],
  };
}

function dedupeCodex(rules: CodexPrefixRule[]): CodexPrefixRule[] {
  const merged = new Map<string, CodexPrefixRule>();
  for (const rule of rules) {
    const key = JSON.stringify(rule.pattern);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...rule,
        justification: `On your always-ask list: ${rule.rule}`,
      });
      continue;
    }
    if (existing.rule.split("; ").includes(rule.rule)) continue;
    const names = `${existing.rule}; ${rule.rule}`;
    merged.set(key, {
      pattern: rule.pattern,
      rule: names,
      justification: `On your always-ask list: ${names}`,
    });
  }
  return [...merged.values()];
}

export function translateAskRules({
  rules,
  privateFolder,
}: {
  rules: string[];
  privateFolder?: string;
}): TranslatedAskRules {
  const claude: Entry[] = [];
  const codex: CodexPrefixRule[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const text = rule.trim();
    if (!text || text.startsWith("#")) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const found = entriesFor(text);
    claude.push(...found.claude);
    codex.push(...found.codex);
  }
  const grok: Entry[] = claude.map((entry) => ({ ...entry, harness: "grok" }));
  if (privateFolder) {
    claude.push(...privatePatterns(privateFolder).filter((entry) => entry.harness === "claude"));
    grok.push(...privatePatterns(privateFolder).filter((entry) => entry.harness === "grok"));
  }
  return {
    claude: unique(claude.map((entry) => entry.pattern)),
    grok: unique(grok.map((entry) => entry.pattern)),
    codex: dedupeCodex(codex),
  };
}

function unique(values: string[]) {
  return [...new Set(values)];
}

export function codexRulesSource(rules: CodexPrefixRule[]) {
  return rules
    .map(
      (rule) =>
        `prefix_rule(\n    pattern = [${rule.pattern.map(starlarkString).join(", ")}],\n    decision = "prompt",\n    justification = ${starlarkString(rule.justification)},\n)\n`,
    )
    .join("\n");
}

function escapeRegex(text: string) {
  return text.replaceAll(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function splitSegments(command: string) {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const rest = command.slice(index);
    const operator = /^(?:&&|\|\||[;&|\n])/.exec(rest);
    if (operator) {
      segments.push(current);
      current = "";
      index += operator[0].length - 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

export function bashPatternMatches(command: string, rule: string) {
  const body = bashBody(rule);
  if (body === null) return false;
  const pattern = body.trim();
  if (!pattern || pattern === "*") return true;
  return splitSegments(command).some((segment) => segmentMatches(segment, pattern));
}

function segmentMatches(segment: string, pattern: string) {
  if (pattern.endsWith(" *") && !pattern.slice(0, -2).includes("*")) {
    const prefix = pattern.slice(0, -2);
    if (segment === prefix || segment.startsWith(`${prefix} `)) return true;
  }
  const expression = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${expression}$`).test(segment);
}

function toolGlobMatches(pattern: string, toolName: string) {
  if (pattern.includes("(")) return false;
  const expression = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp(`^${expression}$`, "i").test(toolName);
}

function ruleRoot(pattern: string) {
  const body = /^(?:Edit|Read|Write)\((.*)\)$/s.exec(pattern)?.[1];
  if (!body) return null;
  const trimmed = body.replace(/\/\*\*$/, "");
  if (trimmed.startsWith("//")) return trimmed.slice(1);
  return trimmed;
}

function isInside(root: string, path: string) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path === root || path.startsWith(prefix);
}

function filePathOf(input: unknown) {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const path = record.file_path ?? record.filePath ?? record.path ?? record.notebook_path;
  return typeof path === "string" ? path : null;
}

function listedEntries(
  rules: string[],
  privateFolder: string | undefined,
  harness: "claude" | "grok",
) {
  const translated = translateAskRules({ rules, privateFolder });
  const patterns = harness === "grok" ? translated.grok : translated.claude;
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const text = rule.trim();
    if (!text || text.startsWith("#") || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    for (const entry of entriesFor(text).claude) {
      if (patterns.includes(entry.pattern)) entries.push({ ...entry, harness });
    }
  }
  if (privateFolder) {
    entries.push(...privatePatterns(privateFolder).filter((entry) => entry.harness === harness));
  }
  return entries;
}

export function matchAskRule({
  rules,
  toolName,
  input,
  cwd,
  privateFolder,
  harness = "claude",
}: {
  rules: string[];
  toolName: string;
  input: unknown;
  cwd: string;
  privateFolder?: string;
  harness?: "claude" | "grok" | "codex";
}): AskMatch | null {
  if (harness === "codex") {
    const command = shellCommand(toolName, input);
    if (command === null) return null;
    const tokens = command.trim().split(/\s+/);
    for (const rule of translateAskRules({ rules, privateFolder }).codex) {
      const same = rule.pattern.every((token, index) => tokens[index] === token);
      if (same) return { rule: rule.rule, remember: true };
    }
    return null;
  }
  const command = shellCommand(toolName, input);
  const kind = FILE_TOOLS[toolName.toLowerCase()];
  const file = filePathOf(input);
  for (const entry of listedEntries(rules, privateFolder, harness)) {
    const body = bashBody(entry.pattern);
    if (body !== null) {
      if (command !== null && bashPatternMatches(command, entry.pattern)) {
        return { rule: entry.rule, remember: entry.remember };
      }
      continue;
    }
    const root = ruleRoot(entry.pattern);
    if (root && kind && file) {
      const wants = entry.pattern.startsWith("Read(") ? "read" : "edit";
      if (wants !== kind) continue;
      const target = resolve(cwd, file);
      const folder = root.startsWith("/") ? root : resolve(cwd, root);
      if (!isInside(folder, target)) continue;
      if (entry.rule === BUSYBOY_FILES_RULE && isInside(resolve(cwd), target)) continue;
      return { rule: entry.rule, remember: entry.remember };
    }
    if (toolGlobMatches(entry.pattern, toolName)) {
      return { rule: entry.rule, remember: entry.remember };
    }
  }
  return null;
}
