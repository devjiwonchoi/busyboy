import { readdirSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isTestMode } from "../config";
import { alwaysAskApproval, matchAlwaysAsk, ruleError, UNREADABLE } from "./always-ask";
import type { AgentEvent } from "./contract";

// why: A check that cannot be read blocks too. In test mode each journey has its own folder, so it never reads the real ~/.jwn.

const RULE_FILE = /\.(md|ya?ml)$/i;
const MAX_FILES = 100;
const MAX_BYTES = 256 * 1024;

export type UserRule = { name: string; block: string; reason: string; file: string };

export type UserRuleCheck =
  | { ask: false }
  | {
      ask: true;
      ruleKey: string;
      detail: string;
      remember: boolean;
    };

export function rulesFolderFor(dataFolder: string) {
  return isTestMode() ? join(dataFolder, "user-jwn") : join(homedir(), ".jwn");
}

export function resolveRulesFolder(given: string | undefined) {
  if (given) return given;
  if (isTestMode()) return undefined;
  return join(homedir(), ".jwn");
}

export async function loadUserRules(rulesFolder: string | undefined) {
  const folder = resolveRulesFolder(rulesFolder);
  if (!folder) return [];
  return loadRules(folder);
}

/*why: * Whether the hook must be installed so a rules check cannot be skipped. A folder that cannot be read still needs the hook: the check then fails closed. */
export function userRulesHookNeeded(rulesFolder: string | undefined) {
  const folder = resolveRulesFolder(rulesFolder);
  if (!folder) return false;
  try {
    return readdirSync(/*turbopackIgnore: true*/ folder).some((name) => RULE_FILE.test(name));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function failedRuleCheck(error: unknown): UserRuleCheck {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ask: true,
    ruleKey: "user-rule-error",
    remember: false,
    detail: `BusyBoy could not check the rules in ~/.jwn, so this action is blocked. ${oneLine(message)}`,
  };
}

export function userRuleDetail(rule: UserRule) {
  const name = rule.name ? `${rule.name} (${rule.block})` : rule.block;
  const reason = rule.reason ? ` ${rule.reason}` : "";
  return `Blocked by a rule in ~/.jwn: ${name}.${reason}`;
}

export function userRuleApproval({
  requestId,
  toolName,
  input,
  detail,
  remember,
}: {
  requestId: string;
  toolName: string;
  input: unknown;
  detail: string;
  remember: boolean;
}): Extract<AgentEvent, { type: "approval" }> {
  const event = alwaysAskApproval({ requestId, toolName, input, rule: "user-rule" });
  return { ...event, detail, canAllowForSession: remember };
}

export async function checkUserRules({
  rulesFolder,
  toolName,
  input,
  cwd,
  recordFolder,
}: {
  rulesFolder: string | undefined;
  toolName: string;
  input: unknown;
  cwd: string;
  /*why: * The task's jwn record folder, counted as inside the task folder by the delete rule. */
  recordFolder?: string;
}): Promise<UserRuleCheck> {
  try {
    const folder = resolveRulesFolder(rulesFolder);
    if (!folder) return { ask: false };
    const rules = await loadRules(folder);
    if (rules.length === 0) return { ask: false };
    const matched = matchAlwaysAsk({
      rules: rules.map((rule) => rule.block),
      toolName,
      input,
      folder: cwd || folder,
      recordFolder,
    });
    if (!matched) return { ask: false };
    if (matched.startsWith(UNREADABLE)) {
      return {
        ask: true,
        ruleKey: `user-rule-unreadable:${matched}`,
        remember: false,
        detail: `Blocked by the rules in ~/.jwn. ${matched}.`,
      };
    }
    const rule = rules.find((candidate) => candidate.block === matched) ?? {
      name: "",
      block: matched,
      reason: "",
      file: "",
    };
    return {
      ask: true,
      ruleKey: `user-rule:${rule.file}:${rule.block}`,
      remember: true,
      detail: userRuleDetail(rule),
    };
  } catch (error) {
    return failedRuleCheck(error);
  }
}

async function loadRules(folder: string): Promise<UserRule[]> {
  let names: string[];
  try {
    names = (await readdir(/*turbopackIgnore: true*/ folder))
      .filter((name) => RULE_FILE.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `Could not read ~/.jwn: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
    );
  }
  if (names.length > MAX_FILES) throw new Error(`~/.jwn has more than ${MAX_FILES} rule files.`);
  const rules: UserRule[] = [];
  for (const name of names) {
    const path = join(/*turbopackIgnore: true*/ folder, name);
    const stats = await lstat(/*turbopackIgnore: true*/ path);
    if (stats.isSymbolicLink()) throw new Error(`${name} is a symbolic link.`);
    if (!stats.isFile()) throw new Error(`${name} is not a file.`);
    if (stats.size > MAX_BYTES) throw new Error(`${name} is larger than 256KB.`);
    const text = await readFile(/*turbopackIgnore: true*/ path, "utf8");
    rules.push(
      ...(name.toLowerCase().endsWith(".md") ? parseMarkdown(text, name) : parseYaml(text, name)),
    );
  }
  return rules;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

function unquote(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function finish(
  partial: { name?: string; block?: string; tool?: string; pattern?: string; reason?: string },
  file: string,
): UserRule {
  const block =
    partial.block ||
    (partial.tool ? (partial.pattern ? `${partial.tool}(${partial.pattern})` : partial.tool) : "");
  if (!block) throw new Error(`${file}: a rule needs "block:" or "tool:".`);
  const problem = ruleError(block);
  if (problem) throw new Error(`${file}: ${problem}`);
  return { name: partial.name ?? "", block, reason: partial.reason ?? "", file };
}

// why: Anything that only looks like rules is an error, so it cannot be treated as an empty file.
function parseYaml(text: string, file: string): UserRule[] {
  const rules: UserRule[] = [];
  let current: {
    name?: string;
    block?: string;
    tool?: string;
    pattern?: string;
    reason?: string;
  } | null = null;
  let sawList = false;
  let content = false;
  const flush = () => {
    if (!current) return;
    rules.push(finish(current, file));
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || /^\s*#/.test(line)) continue;
    content = true;
    if (line === "rules:" || line === "rules: []") {
      sawList = true;
      if (line.endsWith("[]")) return [];
      continue;
    }
    const item = /^(\s*)-\s+(.*)$/.exec(line);
    if (item) {
      flush();
      sawList = true;
      current = {};
      if (item[2]) assign(current, item[2], file);
      continue;
    }
    const field = /^\s+[A-Za-z]+:\s*.*$/.exec(line);
    if (field && current) {
      assign(current, line.trim(), file);
      continue;
    }
    throw new Error(
      `${file}: could not read "${oneLine(line)}". Write a "rules:" list, or Markdown "Block:" lines.`,
    );
  }
  flush();
  if (content && !sawList)
    throw new Error(`${file}: could not read the rules. Start the file with "rules:".`);
  return rules;
}

function assign(
  rule: { name?: string; block?: string; tool?: string; pattern?: string; reason?: string },
  text: string,
  file: string,
) {
  const match = /^([A-Za-z]+):\s*(.*)$/.exec(text.trim());
  if (!match) throw new Error(`${file}: could not read "${oneLine(text)}".`);
  const key = match[1].toLowerCase();
  const value = unquote(match[2].trim());
  if (
    key === "name" ||
    key === "block" ||
    key === "tool" ||
    key === "pattern" ||
    key === "reason"
  ) {
    rule[key] = value;
    return;
  }
  throw new Error(`${file}: unknown field "${key}". Use name, block, tool, pattern, or reason.`);
}

function parseMarkdown(text: string, file: string): UserRule[] {
  const rules: UserRule[] = [];
  let heading = "";
  let inFence = false;
  let current: UserRule | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const head = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (head) {
      heading = head[1].trim();
      current = null;
      continue;
    }
    const block = /^\s*(?:[-*]\s*)?Block:\s*(.+)$/i.exec(line);
    if (block) {
      const pattern = block[1].trim();
      const problem = ruleError(pattern);
      if (problem) throw new Error(`${file}: ${problem}`);
      current = { name: heading, block: pattern, reason: "", file };
      rules.push(current);
      continue;
    }
    const reason = /^\s*(?:[-*]\s*)?Reason:\s*(.+)$/i.exec(line);
    if (reason && current && !current.reason) current.reason = reason[1].trim();
  }
  return rules;
}
