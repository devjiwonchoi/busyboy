import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, constantFrom, property, string } from "fast-check";

import {
  DEFAULT_ALWAYS_ASK,
  DELETE_OUTSIDE_RULE,
  DEPLOY_RULE,
  FORCE_PUSH_RULE,
  matchAlwaysAsk,
  UNREADABLE,
} from "../src/server/runner/always-ask.ts";

const SEED = 20_261_117;
const RUNS = 80;

const root = mkdtempSync(join(tmpdir(), "busyboy-ask-"));
const worktree = join(root, "work");
const records = join(root, "records");
const outside = join(root, "outside");
const sibling = join(root, "work-extra");
const scratch = join(worktree, ".busyboy-scratch");
for (const folder of [worktree, records, outside, sibling, scratch]) mkdirSync(folder);

const segment = string({
  minLength: 1,
  maxLength: 8,
  unit: constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
});

function quoted(text: string) {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function asked(command: string, recordFolder?: string) {
  return matchAlwaysAsk({
    rules: DEFAULT_ALWAYS_ASK,
    toolName: "Bash",
    input: { command },
    folder: worktree,
    recordFolder,
  });
}

function deleteForms(target: string) {
  const q = quoted(target);
  return [
    `rm -rf -- ${q}`,
    `A=${q}; rm -rf -- "$A"`,
    `A=${q} && rm -rf -- "$A"`,
    `export A=${q}; rm -rf -- "$A"`,
    `A=${q}\nrm -rf -- "$A"`,
  ];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function check(name: string, fix: string, run: () => void) {
  try {
    run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(["Always-ask property failed: " + name, fix, detail].join("\n"));
  }
}

const outsideFix = [
  "Fix deletesOutside in src/server/runner/always-ask.ts.",
  "A path that is not inside the task worktree or the record folder matches Delete outside the task folder, including after a shell assignment is expanded.",
  "Resolve persisted assignments (;, &&, export, and a later line) before matching. A prefix assignment does not: the shell expands the command first.",
].join(" ");

const insideFix = [
  "Fix deletesOutside in src/server/runner/always-ask.ts.",
  "A delete inside the task worktree, the record folder, or .busyboy-scratch does not ask.",
  "Resolve persisted assignments to those folders before matching, or the variable stays dynamic and is treated as outside.",
].join(" ");

const forceFix = [
  "Fix isForcePush in src/server/runner/always-ask.ts.",
  "git push --force, -f, --force-with-lease, --mirror, and a refspec that starts with + ask, including when that flag or refspec comes from a resolved assignment.",
].join(" ");

const publishFix = [
  "Fix deploys in src/server/runner/always-ask.ts.",
  "An unresolved publish, deploy, push, or upload on a publisher asks.",
  "publisherHasUnresolvedVerb treats a dynamic subcommand as a publish.",
  "A resolved assignment such as VERB=publish; npm $VERB is the same command as npm publish.",
].join(" ");

const publishers = [
  "aws",
  "cargo",
  "docker",
  "firebase",
  "fly",
  "flyctl",
  "gem",
  "gh",
  "helm",
  "heroku",
  "kubectl",
  "netlify",
  "npm",
  "pnpm",
  "pulumi",
  "railway",
  "serverless",
  "sls",
  "terraform",
  "tofu",
  "twine",
  "vc",
  "vercel",
  "wrangler",
  "yarn",
];

check("an unresolved publish always asks.", publishFix, () => {
  for (const name of publishers) {
    const command = `${name} $VERB`;
    const rule = asked(command);
    if (rule !== DEPLOY_RULE) {
      throw new Error(`\`${command}\` returned ${String(rule)}, not ${DEPLOY_RULE}.`);
    }
  }
  for (const command of [
    "wrangler pages $VERB",
    "wrangler versions $VERB",
    "yarn npm $VERB",
    "gh release $VERB",
    "gh workflow $VERB",
    "aws s3 $VERB",
    "aws cloudformation $VERB",
    "$CMD publish",
    "$CMD deploy",
    "$CMD push",
  ]) {
    const rule = asked(command);
    const asks = rule === DEPLOY_RULE || (typeof rule === "string" && rule.startsWith(UNREADABLE));
    if (!asks) throw new Error(`\`${command}\` returned ${String(rule)} and did not ask.`);
  }
});

check("a shell assignment is resolved before a publish is matched.", publishFix, () => {
  const pairs: [string, string][] = [
    ["npm publish", "VERB=publish; npm $VERB"],
    ["pnpm publish", "VERB=publish; pnpm $VERB"],
    ["cargo publish", "VERB=publish; cargo $VERB"],
    ["gem push", "VERB=push; gem $VERB"],
    ["twine upload", "VERB=upload; twine $VERB"],
    ["wrangler deploy", "VERB=deploy; wrangler $VERB"],
    ["npm publish", "CMD=npm; $CMD publish"],
    ["cargo publish", "CMD=cargo; $CMD publish"],
  ];
  for (const [direct, via] of pairs) {
    const left = asked(direct);
    const right = asked(via);
    if (left !== DEPLOY_RULE || right !== left) {
      throw new Error(
        `\`${direct}\` returned ${String(left)}; \`${via}\` returned ${String(right)}.`,
      );
    }
  }
});

check(
  "a delete outside the worktree and the record folder always asks, and an assignment to that path does too.",
  outsideFix,
  () => {
    assert(
      property(segment, constantFrom("outside", "sibling", "relative", "prefix"), (name, kind) => {
        const target =
          kind === "outside"
            ? join(outside, name)
            : kind === "sibling"
              ? join(sibling, name)
              : kind === "relative"
                ? `../outside/${name}`
                : `../work-extra/${name}`;
        for (const command of deleteForms(target)) {
          const rule = asked(command, records);
          if (rule !== DELETE_OUTSIDE_RULE) {
            throw new Error(`\`${command}\` returned ${String(rule)}, not ${DELETE_OUTSIDE_RULE}.`);
          }
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  },
);

check(
  "an ordinary command inside the worktree, the record folder, or .busyboy-scratch never asks.",
  insideFix,
  () => {
    assert(
      property(segment, (name) => {
        const inside = [
          ...deleteForms(`src/${name}`).map((command) => ({ command, recordFolder: records })),
          ...deleteForms(`.busyboy-scratch/${name}`).map((command) => ({
            command,
            recordFolder: records,
          })),
          ...deleteForms(join(scratch, name)).map((command) => ({
            command,
            recordFolder: records,
          })),
          ...deleteForms(join(records, name)).map((command) => ({
            command,
            recordFolder: records,
          })),
          { command: "pwd", recordFolder: records },
          { command: "git status", recordFolder: records },
          { command: "git diff --stat", recordFolder: records },
          { command: `echo ${name}`, recordFolder: records },
          { command: `ls ${name}`, recordFolder: records },
          { command: `mkdir -p ${name}`, recordFolder: records },
          { command: `cd ${quoted(records)} && rm -rf -- ${name}`, recordFolder: records },
          { command: `cd ${quoted(scratch)} && rm -rf -- ${name}`, recordFolder: undefined },
        ];
        for (const { command, recordFolder } of inside) {
          const rule = asked(command, recordFolder);
          if (rule !== null) throw new Error(`\`${command}\` returned ${String(rule)}.`);
        }
        const hidden = asked(`A=${quoted(join(records, name))}; rm -rf -- "$A"`);
        if (hidden !== DELETE_OUTSIDE_RULE) {
          throw new Error(
            `The same record-folder delete without recordFolder returned ${String(hidden)}.`,
          );
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  },
);

check(
  "a force push always asks, including when the flag or the refspec is a resolved assignment.",
  forceFix,
  () => {
    assert(
      property(segment, (branch) => {
        const forms = [
          `git push --force origin ${branch}`,
          `git push -f origin ${branch}`,
          `git push --force-with-lease origin ${branch}`,
          `git push --force-with-lease=${branch} origin`,
          `git push origin +${branch}`,
          `git push --mirror`,
          `REF=+${branch}; git push origin "$REF"`,
          `OPT=--force; git push "$OPT" origin ${branch}`,
          `F=-f; git push $F origin ${branch}`,
          "git push origin $REF",
        ];
        for (const command of forms) {
          const rule = asked(command);
          if (rule !== FORCE_PUSH_RULE) {
            throw new Error(`\`${command}\` returned ${String(rule)}, not ${FORCE_PUSH_RULE}.`);
          }
        }
        const direct = asked(`git push origin +${branch}`);
        const via = asked(`REF=+${branch}; git push origin $REF`);
        if (direct !== via) {
          throw new Error(
            `git push origin +${branch} returned ${String(direct)}; the REF assignment returned ${String(via)}.`,
          );
        }
      }),
      { seed: SEED, numRuns: RUNS },
    );
  },
);

rmSync(root, { recursive: true, force: true });
console.log(`Always-ask properties hold (${RUNS} generated commands per property, seed ${SEED}).`);
