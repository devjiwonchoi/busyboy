import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentEvent } from './contract'

// The "always ask" list: actions a task agent must get the user's approval for
// every time, even where the provider's Auto mode would run them without asking
// (merges, deploys, force pushes, deletes outside the task, messages sent through
// connectors). Each provider adapter checks every tool call against the list
// before it runs, through the provider's own pre-tool-use hook, and asks with an
// approval (an approval card in the Director chat) when one matches.
//
// One rule per line:
//   Tool                 a tool name, `*` matching any characters (mcp__*linear*__*update*)
//   Tool(pattern)        a tool and what it runs, also with `*`. For Bash the pattern is
//                        matched against each command a command line runs, as written and
//                        with wrappers (sudo, env, npx, bash -c, /usr/bin/) and git's
//                        global options taken off: Bash(gh pr merge*)
//   a built-in rule      the BUILT_IN_RULES below, for actions no pattern can spell in full
//
// Matching fails closed: a shell command whose effect cannot be read (a command
// built from a substitution, a wrapper option it does not know, a script read
// from input) asks as long as the list has any shell rule. Package scripts,
// Makefiles, and script files a command runs are read and checked too.
//
// Known limits: code a command runs that is not a command line (a Node or Python
// script file, git hooks, build scripts, test configs) is not read, and a
// redirection that overwrites a file is not a delete. Code given on the command
// line (`node -e`, `python3 -c`) is read with comments and string literals taken
// out, then by the calls that remain: a word inside a string or a comment is not
// a call, and a call still asks when spaces or a comment sit between its parts.
// An apply_patch heredoc or a JSON wrapper around a patch is read for the files
// it names, not as a shell script, so a diff that mentions a command does not ask.

export const FORCE_PUSH_RULE = 'Force push or delete a remote branch'
export const DEFAULT_BRANCH_RULE = 'Push to the default branch'
export const DEPLOY_RULE = 'Deploy, publish, or change infrastructure'
export const DELETE_OUTSIDE_RULE = 'Delete outside the task folder'
export const CONNECTOR_RULE = 'Send, post, merge, publish, or delete through a connector'

const BUILT_IN_RULES = [FORCE_PUSH_RULE, DEFAULT_BRANCH_RULE, DEPLOY_RULE, DELETE_OUTSIDE_RULE, CONNECTOR_RULE]

/**
 * Not a rule on the list: an agent started with a private folder (the Director, whose
 * folder sits inside BusyBoy's data folder) may not change anything in it outside its
 * own working folder, where BusyBoy keeps the task list and settings.
 */
export const BUSYBOY_FILES_RULE = "Change BusyBoy's own files"

/**
 * Not a rule on the list either: a subagent runs a short command in the project's own
 * checkout, which the user works in, so anything that could change it asks: file tools, and
 * any shell command not known to only read (READ_ONLY_COMMANDS). Changes go through a task.
 */
export const SUBAGENT_EDIT_RULE = 'Change the project checkout as a subagent'

/** Commands that only read, by name; `find`, `git`, `gh`, and `curl` are checked further in onlyReads. */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'jq', 'echo', 'printf', 'pwd', 'which', 'date', 'sort', 'uniq',
  'cut', 'tr', 'basename', 'dirname', 'realpath', 'stat', 'file', 'tree', 'du', 'df', 'uname', 'whoami', 'sleep',
  'true', 'false', 'test', '[', 'find', 'git', 'gh', 'curl',
])

/** git subcommands that only read the repository (fetch updates remote refs only, not the checkout). */
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'fetch', 'ls-files', 'ls-remote', 'describe', 'blame', 'shortlog', 'grep', 'rev-list', 'cat-file'])

/** gh subcommands that write into the local checkout, its git config, or the file system. */
const GH_LOCAL_WRITES = new Set([
  'checkout', 'clone', 'download', 'sync', 'install', 'upgrade', 'create', 'fork', 'set-default', 'codespace', 'develop', 'rename',
  'setup-git', 'login', 'logout', 'refresh', 'switch',
])

/** gh command groups; any other first word may be an alias (`gh co` is `gh pr checkout`). */
const GH_GROUPS = new Set(['pr', 'issue', 'run', 'workflow', 'repo', 'release', 'api', 'search', 'status', 'browse', 'label', 'cache', 'auth', 'gist', 'project', 'secret', 'variable', 'ruleset', 'org'])

/** `git fetch` options that only update remote-tracking refs; `--prune-tags` and `--set-upstream` change local state. */
const FETCH_OPTIONS = /^(-q|--quiet|-v|--verbose|--all|-p|--prune|-t|--tags|--no-tags|--dry-run|--depth=\d+|--no-recurse-submodules)$/

/** Whether a command only reads: a read-only command, used without options that write. */
function onlyReads({ argv, written }: Fact) {
  const [name, ...args] = argv.map(({ text }) => text)
  // Inline code is a fact only once it is known to run no command; here it must not write either.
  const code = inlineCode(name, argv.slice(1), true)
  if (typeof code === 'string') return !INLINE_WRITES.test(code)
  if (!READ_ONLY_COMMANDS.has(name)) return false
  // `sort -o` and `tree -o` write their output to a file; `uniq in out` writes to its second file.
  // GNU takes any unambiguous start of a long option (`--out=f`), so every `--o…` counts.
  if ((name === 'sort' || name === 'tree') && args.some((arg) => /^(-[a-zA-Z]*o|--o)/.test(arg))) return false
  if (name === 'uniq' && args.filter((arg) => arg === '-' || !arg.startsWith('-')).length > 1) return false
  if (name === 'find') return !args.some((arg) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg))
  if (name === 'curl') {
    return !args.some((arg) => /^(-[a-zA-Z]*[oOD]|-c$|--(output|remote-name|create-dirs|dump-header|cookie-jar|trace|stderr|libcurl|etag-save|hsts|alt-svc))/.test(arg))
  }
  if (name === 'git') {
    // Global options (-C, -c, --no-pager) come before the subcommand.
    // A `-c` config value can name a command git runs (core.pager, core.fsmonitor). The matcher
    // takes git's global options off `argv`, so they are looked for as written.
    if (written.some(({ text }) => /^-c|^--config-env/.test(text))) return false
    let index = 0
    while (index < args.length && args[index].startsWith('-')) {
      if (/^-c|^--config-env/.test(args[index])) return false
      index += args[index] === '-C' ? 2 : 1
    }
    const command = args[index]
    const rest = args.slice(index + 1)
    const names = rest.filter((arg) => !arg.startsWith('-'))
    // These name a program git runs on the other side of a fetch or ls-remote.
    if (rest.some((arg) => /upload-pack|receive-pack|^--exec|^-u$/.test(arg))) return false
    if (command === 'branch') return rest.every((arg) => /^-(a|r|v|vv|l|-list|-all|-remotes|-show-current|-contains|-merged|-no-merged)$/.test(arg))
    if (command === 'remote') {
      return rest.length === 0 || (rest.length === 1 && rest[0] === '-v') || (rest.length === 2 && (rest[0] === 'show' || rest[0] === 'get-url') && !rest[1].startsWith('-'))
    }
    if (command === 'stash') return rest[0] === 'list' || rest[0] === 'show'
    if (command === 'tag') return rest.length === 0 || rest[0] === '-l' || rest[0] === '--list'
    if (command === 'config') return rest[0] === '--get' || rest[0] === '--list' || rest[0] === '-l' || rest[0] === '--get-all'
    if (command === 'worktree') return rest[0] === 'list'
    // `git fetch origin main:main` moves a local branch.
    if (command === 'fetch') return !names.some((arg) => arg.includes(':')) && rest.every((arg) => !arg.startsWith('-') || FETCH_OPTIONS.test(arg))
    // `git grep -O<command>` opens the matches in a command.
    if (command === 'grep') return !rest.some((arg) => /^(-[a-zA-Z]*O|--open-files-in-pager)/.test(arg))
    return GIT_READS.has(command) && !rest.some((arg) => /^--output(=|$)/.test(arg))
  }
  // `gh pr merge --delete-branch` also switches the checkout and deletes the local branch.
  if (name === 'gh' && args[0] === 'pr' && args[1] === 'merge' && args.some((arg) => /^(-[a-zA-Z]*d|--delete-branch)(=|$)/.test(arg))) return false
  if (name === 'gh') return GH_GROUPS.has(args[0]) && !args.some((arg) => GH_LOCAL_WRITES.has(arg))
  return true
}

/** Redirections that write somewhere other than the terminal or /dev/null, in a script with its quoted text taken out. */
const WRITE_REDIRECT = />>?(?!\s*(?:&\s*[\d-](?![\w./])|\/dev\/null\b))/
// Escaped characters go first, so `\'` is not taken for a quote that hides a real `>`.
const unquoted = (script: string) => script.replace(/\\./g, 'x').replace(/'[^']*'|"[^"]*"/g, "''")

/** Whether a subagent's tool call could change its checkout, so it asks with SUBAGENT_EDIT_RULE. */
function subagentChanges({ toolName, script, facts, unknown }: { toolName: string; script: string | null; facts: Fact[]; unknown: string | null }) {
  if (toolName in FILE_TOOLS || isPatchTool(toolName)) return true
  if (script === null) return false
  return unknown !== null || WRITE_REDIRECT.test(unquoted(script).replace(/\d?>&\d/g, '')) || !facts.every(onlyReads)
}

/** How a card names a command that matching could not read. */
export const UNREADABLE = 'BusyBoy cannot tell what this command runs'

export const DEFAULT_ALWAYS_ASK = [
  FORCE_PUSH_RULE,
  DEFAULT_BRANCH_RULE,
  DEPLOY_RULE,
  DELETE_OUTSIDE_RULE,
  CONNECTOR_RULE,
  'Bash(gh pr merge*)',
  'Bash(gh * pr merge*)',
  'Bash(gh api *merge*)',
  'Bash(gh api *DELETE*)',
  'Bash(gh repo sync*--force*)',
  'Bash(gh * repo sync*--force*)',
  'Bash(gh repo delete*)',
  'Bash(gh * repo delete*)',
  'Bash(gh release delete*)',
  'Bash(gh * release delete*)',
  // Writes that change what the team sees, beyond the connector verbs.
  'mcp__*linear*__*update*',
  'mcp__*linear*__*save*',
  'mcp__*notion*__*update*',
]

/**
 * Shell tool names, whose input is matched by its command. Claude says `Bash`.
 * Codex's hook says `Bash` too, and also the names of the tools it wraps
 * (`shell_command`, `container.exec`) when a call arrives under its own name.
 */
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec_command', 'local_shell', 'unified_exec', 'shell_command', 'container.exec'])

const isShellTool = (toolName: string) => SHELL_TOOLS.has(toolName.toLowerCase())

/** Codex's patch tool, under either name it is called. */
function isPatchTool(toolName: string) {
  const name = toolName.toLowerCase()
  return name === 'apply_patch' || name === 'applypatch'
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh', 'csh', 'mksh', 'yash'])

/**
 * Commands that run the command after them, with the options each knows.
 * `value`: options that take the next word. `flags`: options that take none.
 * `operands`: plain words before the command (timeout's duration). Any other
 * option is unknown, so the command cannot be read and asks.
 */
const WRAPPERS: Record<string, { value: string[]; flags: string[]; operands?: number }> = {
  sudo: {
    value: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir'],
    flags: ['-A', '-b', '-E', '-H', '-k', '-K', '-n', '-P', '-S', '-s', '-i', '-B', '--preserve-env', '--non-interactive'],
  },
  env: { value: ['-u', '-C', '--unset', '--chdir'], flags: ['-i', '-0', '-v', '--ignore-environment', '--null', '--debug', '-'] },
  nice: { value: ['-n', '--adjustment'], flags: [] },
  timeout: {
    value: ['-s', '-k', '--signal', '--kill-after'],
    flags: ['-v', '-f', '-p', '--verbose', '--foreground', '--preserve-status'],
    operands: 1,
  },
  xargs: {
    value: [
      '-n', '-I', '-L', '-l', '-s', '-P', '-d', '-E', '-e', '-a', '-J', '-R', '-S',
      '--max-args', '--replace', '--max-lines', '--max-procs', '--delimiter', '--arg-file',
    ],
    flags: ['-0', '-r', '-t', '-p', '-x', '-o', '--null', '--no-run-if-empty', '--verbose', '--interactive', '--exit', '--open-tty'],
  },
  exec: { value: ['-a'], flags: ['-c', '-l'] },
  command: { value: [], flags: ['-p'] },
  nohup: { value: [], flags: [] },
  time: { value: ['-f', '-o', '--format', '--output'], flags: ['-p', '-a', '-v', '-l', '--portability', '--append', '--verbose'] },
  caffeinate: { value: ['-w', '-t'], flags: ['-d', '-i', '-m', '-s', '-u'] },
  npx: { value: ['-p', '--package'], flags: ['-y', '--yes', '--no', '-q', '--quiet'] },
  bunx: { value: ['-p', '--package'], flags: ['--bun'] },
  stdbuf: { value: ['-i', '-o', '-e', '--input', '--output', '--error'], flags: [] },
  // GNU parallel has too many options to list; with any of them the command cannot be read.
  parallel: { value: [], flags: [] },
  builtin: { value: [], flags: [] },
  'cross-env': { value: [], flags: [] },
  'cross-env-shell': { value: [], flags: [] },
  // `script [-q] <file> <command>` (macOS) records a command's output to a file.
  script: { value: ['-t', '-T'], flags: ['-q', '-a', '-k', '-F', '-r', '-p', '-e'], operands: 1 },
  flock: { value: ['-w', '-E', '--timeout', '--conflict-exit-code'], flags: ['-s', '-x', '-n', '-u', '-o', '--shared', '--exclusive', '--nonblock', '--close'], operands: 1 },
  watch: { value: ['-n', '--interval'], flags: ['-t', '-d', '-b', '-e', '-g', '-c', '-x', '-p', '--no-title', '--differences', '--beep', '--errexit', '--chgexit', '--color', '--exec', '--precise'] },
  dotenv: { value: ['-e', '-v', '-c'], flags: ['-o', '-p'] },
}

/** Shell keywords that can start a simple command in a compound one. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done', 'esac'])

const DELETERS = new Set(['rm', 'rmdir', 'unlink', 'trash', 'trash-put', 'shred', 'srm', 'rimraf', 'del', 'del-cli'])

/** pnpm and yarn commands that are not package scripts, so `pnpm <name>` runs a script only for other names. */
const PACKAGE_MANAGER_COMMANDS = new Set([
  'add', 'audit', 'bin', 'cache', 'config', 'create', 'dedupe', 'deploy', 'dlx', 'env', 'exec', 'fetch', 'help', 'i', 'import', 'info',
  'init', 'install', 'licenses', 'link', 'list', 'ls', 'outdated', 'pack', 'patch', 'patch-commit', 'prune', 'publish', 'rebuild',
  'remove', 'rm', 'root', 'server', 'setup', 'store', 'un', 'uninstall', 'unlink', 'up', 'update', 'upgrade', 'why', 'workspace',
  'workspaces', 'version', 'whoami', 'login', 'logout', 'npm', 'set', 'plugin', 'constraints', 'explain',
])

/** npm commands that run the package script of the same name. */
const NPM_SCRIPT_ALIASES: Record<string, string> = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop', restart: 'restart' }

/** Vercel commands that do not deploy; any other vercel command (a bare `vercel` too) deploys or changes production. */
const VERCEL_LOCAL = new Set([
  'env', 'pull', 'link', 'login', 'logout', 'ls', 'list', 'inspect', 'logs', 'domains', 'dns', 'certs', 'project', 'projects', 'teams',
  'whoami', 'dev', 'build', 'init', 'git', 'help', 'switch', 'secrets', 'integration', 'telemetry', 'bisect', 'open', 'httpstat',
  'microfrontends', 'curl', 'target', 'blob', 'cache', '-h', '--help', '-v', '--version',
])

/** Connector tool words that send, post, publish, merge, or delete. */
const CONNECTOR_VERBS = new Set(['send', 'post', 'publish', 'merge', 'delete', 'remove', 'invite', 'reply', 'respond', 'share', 'forward', 'trash'])
/** Things a connector `create` or `add` makes that other people see at once. */
const CONNECTOR_CREATED = new Set(['comment', 'message', 'issue', 'email', 'mail', 'event', 'invite', 'invitation', 'reply', 'ticket', 'post', 'page'])

/** How deep commands may hand off to other commands (package scripts, files, `-c` strings) before matching gives up and asks. */
const MAX_DEPTH = 4

/** How many command lines and files one tool call may make the matcher read before it gives up and asks. */
const MAX_STEPS = 400

/**
 * Work done for the tool call being matched: steps taken, files already read, and
 * git answers. The matcher is synchronous and runs one tool call at a time, so one
 * module-level record, reset by each `matchAlwaysAsk`, cannot be shared by two calls.
 */
let run = { steps: 0, files: new Map<string, Analysis>(), git: new Map<string, string | null>() }

/** The largest script or Makefile that is read; a larger one is taken as a binary and matched as itself. */
const MAX_FILE_BYTES = 512 * 1024

/** A word of a command: its text after quotes are removed, and whether a variable or substitution decides part of it. */
type Word = { text: string; dynamic: boolean }

/**
 * A command a command line runs, with what is known about where it runs.
 * `scan`: it was read from a file (a script or a Makefile), where variables are
 * common and are only taken as a home path when they name one.
 */
/** A file an apply_patch call names, and what it does to that file. */
type PatchFile = { path: string; kind: 'add' | 'update' | 'delete' | 'move' }

type Fact = { written: Word[]; argv: Word[]; cwd: string | null; viaXargs: boolean; gitDir: Word | null; scan: boolean; patches: PatchFile[] }

/** `file`: the script or Makefile being read, so `include` resolves against its folder. */
type Context = { cwd: string | null; depth: number; scan: boolean; file?: string }

type Analysis = { facts: Fact[]; unknown: string | null }

const basename = (path: string) => path.replace(/^.*\//, '')
const literal = (text: string): Word => ({ text, dynamic: false })
const unknownOnly = (unknown: string): Analysis => ({ facts: [], unknown })
const NOTHING: Analysis = { facts: [], unknown: null }

/**
 * Reads a `$(…)`, `$((…))`, `<(…)`, or `${…}` starting at `start`: its end index and
 * the command line inside it. A `${…}` runs no command itself, but its body can hold
 * substitutions (`${x:-$(git push -f)}`), so its body is returned to be searched for them.
 */
function readDollar(script: string, start: number): { end: number; inner: string | null; braces?: true } {
  if (script[start + 1] === '{') {
    let depth = 0
    for (let index = start + 1; index < script.length; index++) {
      if (script[index] === '\\') {
        index++
      } else if (script[index] === '{') {
        depth++
      } else if (script[index] === '}' && --depth === 0) {
        return { end: index, inner: script.slice(start + 2, index), braces: true }
      }
    }
    return { end: script.length - 1, inner: script.slice(start + 2), braces: true }
  }
  const arithmetic = script[start + 2] === '('
  let depth = 0
  for (let index = start + 1; index < script.length; index++) {
    const char = script[index]
    if (char === '\\') {
      index++
    } else if (char === "'") {
      const close = script.indexOf("'", index + 1)
      index = close === -1 ? script.length : close
    } else if (char === '(') {
      depth++
    } else if (char === ')') {
      depth--
      if (depth === 0) {
        return { end: index, inner: arithmetic ? null : script.slice(start + 2, index) }
      }
    }
  }
  return { end: script.length - 1, inner: arithmetic ? null : script.slice(start + 2) }
}

/**
 * Splits a command line into simple commands and their words, the way a POSIX
 * shell reads quotes and escapes, and collects the commands that substitutions
 * (`$(…)` and backticks) run. A word with a variable or a substitution in it is
 * dynamic: what it says is only known when the command runs.
 */
function tokenize(script: string): { commands: Word[][]; substitutions: string[]; heredocs: string[][] } {
  const commands: Word[][] = []
  /** Bodies of the here-documents each command redirects, in command order. */
  const heredocs: string[][] = []
  const substitutions: string[] = []
  let words: Word[] = []
  let text = ''
  let started = false
  let dynamic = false
  /** The word being read is a redirection's target (`> file`), which is not an argument. */
  let redirectTarget = false
  /** Here-documents whose bodies start on the next line: their delimiter and whether substitutions in them run. */
  const hereDocs: { delimiter: string; expands: boolean }[] = []

  const endWord = () => {
    if (started && !redirectTarget) {
      words.push({ text, dynamic })
    }
    redirectTarget = false
    text = ''
    started = false
    dynamic = false
  }
  /** Skips the bodies of pending here-documents, which start after the new line at `index`. Returns the index of the last line read. */
  const skipHereDocs = (index: number) => {
    let position = index
    const bodies: string[] = []
    for (const { delimiter, expands } of hereDocs.splice(0)) {
      const lines = script.slice(position + 1).split('\n')
      const length = lines.findIndex((line) => line.replace(/^\t+/, '') === delimiter)
      const body = lines.slice(0, length === -1 ? undefined : length).join('\n')
      // An unquoted delimiter expands substitutions in the body; a quoted one keeps it as text.
      if (expands) {
        substitutions.push(...tokenize(body.replaceAll('"', '\\"').replace(/^/, '"').concat('"')).substitutions)
      }
      bodies.push(body)
      position += body.length + 1 + (length === -1 ? 0 : delimiter.length + 1)
    }
    const last = heredocs.length - 1
    if (last >= 0 && bodies.length > 0) heredocs[last].push(...bodies)
    return Math.min(position, script.length)
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) {
      commands.push(words)
      heredocs.push([])
    }
    words = []
  }
  /** A `$…` at `index`, inside or outside double quotes. Returns the index of its last character. */
  const dollar = (index: number) => {
    started = true
    if (!/[({A-Za-z_0-9@*#?$!-]/.test(script[index + 1] ?? '')) {
      text += '$'
      return index
    }
    dynamic = true
    if (script[index + 1] === '(' || script[index + 1] === '{') {
      const { end, inner, braces } = readDollar(script, index)
      if (inner !== null) {
        substitutions.push(...(braces ? tokenize(`"${inner}"`).substitutions : [inner]))
      }
      text += script.slice(index, end + 1)
      return end
    }
    const name = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(script.slice(index))?.[0] ?? '$'
    text += name
    return index + name.length - 1
  }
  /** A backtick substitution at `index`. Returns the index of its closing backtick. */
  const backtick = (index: number) => {
    const end = script.indexOf('`', index + 1)
    substitutions.push(script.slice(index + 1, end === -1 ? undefined : end))
    dynamic = true
    started = true
    text += '`'
    return end === -1 ? script.length : end
  }

  for (let index = 0; index < script.length; index++) {
    const char = script[index]
    if (char === '\\') {
      if (script[index + 1] !== '\n') {
        text += script[index + 1] ?? ''
        started = true
      }
      index++
    } else if (char === "'") {
      const end = script.indexOf("'", index + 1)
      text += script.slice(index + 1, end === -1 ? undefined : end)
      started = true
      index = end === -1 ? script.length : end
    } else if (char === '"') {
      started = true
      index++
      while (index < script.length && script[index] !== '"') {
        if (script[index] === '\\') {
          text += script[index + 1] ?? ''
          index += 2
        } else if (script[index] === '$') {
          index = dollar(index) + 1
        } else if (script[index] === '`') {
          index = backtick(index) + 1
        } else {
          text += script[index]
          index++
        }
      }
    } else if (char === '$' && script[index + 1] === '"') {
      // $"…" is a translated string: read as a double-quoted one.
      continue
    } else if (char === '$' && script[index + 1] === "'") {
      // ANSI-C quoting: $'git' is git. Escapes other than a few common ones are kept as written.
      let end = index + 2
      while (end < script.length && script[end] !== "'") {
        end += script[end] === '\\' ? 2 : 1
      }
      text += script
        .slice(index + 2, end)
        .replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\([0-7]{1,3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))
        .replace(/\\(.)/g, (_, escaped: string) => ({ n: '\n', t: '\t' })[escaped] ?? escaped)
      started = true
      index = end
    } else if ((char === '<' || char === '>') && script[index + 1] === '(') {
      // Process substitution: <(…) runs a command and reads like a file path decided when it runs.
      const { end, inner } = readDollar(script, index)
      if (inner !== null) {
        substitutions.push(inner)
      }
      text += script.slice(index, end + 1)
      dynamic = true
      started = true
      index = end
    } else if (char === '$') {
      index = dollar(index)
    } else if (char === '`') {
      index = backtick(index)
    } else if (char === '<' || char === '>' || (char === '&' && script[index + 1] === '>')) {
      // A redirection: `2>&1`, `>/dev/null`, `&>log`, `<<EOF`. Its operator and target are not arguments.
      if (started && /^\d+$/.test(text) && !dynamic) {
        // The file descriptor of `2>`.
        text = ''
        started = false
      }
      endWord()
      const operator = /^(&>>?|<<<|<<-?|<>|>>|>&|<&|>\||[<>])/.exec(script.slice(index))?.[0] ?? char
      index += operator.length - 1
      if (operator === '<<' || operator === '<<-') {
        const delimiter = /^\s*(['"]?)([^\s'";&|<>()]+)\1/.exec(script.slice(index + 1))
        if (delimiter) {
          hereDocs.push({ delimiter: delimiter[2], expands: delimiter[1] === '' })
          index += delimiter[0].length
        }
        continue
      }
      // `>&2` and `<&0` name a descriptor right after the operator.
      if (/[&]$/.test(operator) && /^-|\d/.test(script[index + 1] ?? '')) {
        index += /^(-|\d+)/.exec(script.slice(index + 1))?.[0].length ?? 0
        continue
      }
      redirectTarget = true
    } else if (char === ' ' || char === '\t') {
      if (!(redirectTarget && !started)) {
        endWord()
        redirectTarget = false
      }
    } else if (char === '\n') {
      endCommand()
      index = skipHereDocs(index)
    } else if (/[;&|()]/.test(char)) {
      endCommand()
    } else if (char === '{' && /^\{[^{}\s]*(,|\.\.)[^{}\s]*\}/.test(script.slice(index))) {
      // Brace expansion (`{-f,origin}`, `{1..3}`) makes several words from one; what they are is read as unknown.
      const end = script.indexOf('}', index)
      text += script.slice(index, end + 1)
      dynamic = true
      started = true
      index = end
    } else if (char === '#' && !started) {
      // A comment runs to the end of the line.
      const end = script.indexOf('\n', index)
      index = end === -1 ? script.length : end - 1
    } else {
      text += char
      started = true
    }
  }
  endCommand()
  return { commands, substitutions, heredocs }
}

/**
 * Variables that change which program runs or what git does (a git alias set in the
 * environment, a planted binary early on PATH, a shell startup file), so a command
 * given one cannot be read.
 */
const RISKY_VARIABLE = /^(PATH|GIT_CONFIG\w*|GIT_EXEC_PATH|GIT_SSH_COMMAND|GIT_SSH|BASH_ENV|ENV|LD_PRELOAD|DYLD_\w+)=/

/** Takes keywords, variable assignments, and wrappers off the front of a command. Null when it cannot be read. */
function unwrap(words: Word[]): { argv: Word[]; viaXargs: boolean } | null {
  let argv = words
  let viaXargs = false
  for (;;) {
    const [first, second] = argv
    if (!first || first.dynamic) {
      return { argv, viaXargs }
    }
    const name = basename(first.text)
    if (RISKY_VARIABLE.test(first.text)) {
      return null
    }
    if (KEYWORDS.has(first.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text) || first.text === 'coproc') {
      argv = argv.slice(1)
      continue
    }
    if (first.text === 'function') {
      // `function f { …; }`: the name is not a command; the body after it is.
      argv = argv.slice(2)
      continue
    }
    const runsNext =
      ((name === 'pnpm' || name === 'yarn' || name === 'npm') && (second?.text === 'dlx' || second?.text === 'exec' || (name === 'npm' && second?.text === 'x'))) ||
      ((name === 'bun' || name === 'bunx') && second?.text === 'x') ||
      (name === 'busybox' && second !== undefined)
    if (runsNext) {
      argv = argv.slice(name === 'busybox' ? 1 : 2)
      if (argv[0]?.text === '--') {
        argv = argv.slice(1)
      }
      continue
    }
    if (name === 'direnv' && second?.text === 'exec') {
      // `direnv exec <folder> <command>`.
      argv = argv.slice(3)
      continue
    }
    const wrapper = WRAPPERS[name]
    if (!wrapper) {
      return { argv, viaXargs }
    }
    viaXargs ||= name === 'xargs'
    argv = argv.slice(1)
    let operands = wrapper.operands ?? 0
    while (argv[0]) {
      const option = argv[0].text
      if (option === '--') {
        argv = argv.slice(1)
        break
      }
      if ((name === 'env' || name.startsWith('cross-env')) && /^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
        if (RISKY_VARIABLE.test(option)) {
          return null
        }
        argv = argv.slice(1)
        continue
      }
      if (!option.startsWith('-') || option === '-') {
        if (operands > 0) {
          operands--
          argv = argv.slice(1)
          continue
        }
        break
      }
      const [base] = option.split('=')
      const attached = wrapper.value.some((value) => /^-[A-Za-z]$/.test(value) && option.startsWith(value) && option.length > 2)
      if (wrapper.value.includes(base) || attached) {
        // `-n 10`, `--signal=KILL`, or `-I{}`: the value is attached or is the next word.
        argv = argv.slice(option.includes('=') || attached ? 1 : 2)
      } else if (wrapper.flags.includes(option) || (name === 'nice' && /^-\d+$/.test(option))) {
        argv = argv.slice(1)
      } else {
        return null
      }
    }
  }
}

/** The text of a script file a command runs, or null when it is missing, binary, or too large to read. */
function readScript(path: string): string | null {
  try {
    if (!statSync(path).isFile() || statSync(path).size > MAX_FILE_BYTES) {
      return null
    }
    const text = readFileSync(path, 'utf8')
    return text.includes('\u0000') ? null : text
  } catch {
    return null
  }
}

function merge(analyses: Analysis[]): Analysis {
  return { facts: analyses.flatMap(({ facts }) => facts), unknown: analyses.find(({ unknown }) => unknown)?.unknown ?? null }
}

/** Reads a script or Makefile and checks each of its command lines, joining continued lines first. */
function analyzeFile(path: string, context: Context): Analysis {
  const key = JSON.stringify([path, context.cwd])
  const cached = run.files.get(key)
  if (cached) {
    return cached
  }
  // Marked first, so a file that runs itself is read once.
  run.files.set(key, NOTHING)
  const text = readScript(path)
  if (text === null) {
    return NOTHING
  }
  const lines = text
    // Make runs `$(shell …)` as a command line, like `$(…)` in a shell.
    .replaceAll('$(shell ', '$(')
    .replace(/\\\n/g, ' ')
    .split('\n')
    // Make recipe prefixes: `@` (quiet), `-` (ignore errors), `+` (always run).
    .map((line) => line.trim().replace(/^[@+-]+/, ''))
    .filter((line) => line && !line.startsWith('#'))
  const analysis = merge(lines.map((line) => analyze(line, { ...context, cwd: context.cwd, scan: true, file: path })))
  run.files.set(key, analysis)
  return analysis
}

/** The largest number of package folders a workspace command is followed into before it asks instead. */
const MAX_PACKAGES = 100

/** Folders under `root` with a package.json, skipping node_modules and hidden folders; null when there are too many. */
function packageFolders(root: string): string[] | null {
  const found: string[] = []
  const walk = (folder: string, depth: number) => {
    if (found.length > MAX_PACKAGES) {
      return
    }
    if (existsSync(join(folder, 'package.json'))) {
      found.push(folder)
    }
    if (depth >= 4) {
      return
    }
    let entries: { name: string; isDirectory(): boolean }[] = []
    try {
      entries = readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        walk(join(folder, entry.name), depth + 1)
      }
    }
  }
  walk(root, 0)
  return found.length > MAX_PACKAGES ? null : found
}

/** Bun commands that are not package scripts. */
const BUN_COMMANDS = new Set([...PACKAGE_MANAGER_COMMANDS, 'test', 'build', 'x', 'pm', 'repl', 'run', 'upgrade'])

/** Package manager commands that run install lifecycle scripts. */
const INSTALLS = new Set(['install', 'i', 'ci', 'add', 'install-test', 'it', 'clean-install'])

type ScriptRuns = { bodies: { body: string; cwd: string }[]; command: Word[] | null; unknown: string | null }

/**
 * The package.json scripts a package manager or monorepo tool runs: a named script
 * with its pre and post scripts, install lifecycle scripts, and, for a workspace
 * filter or a monorepo runner, that script in every package of the folder.
 * `command`: words `yarn workspace <name>` runs as a command of their own.
 */
function packageScripts({ manager, args, cwd }: { manager: string; args: Word[]; cwd: string }): ScriptRuns {
  let folder = cwd
  let workspaces = manager === 'turbo' || manager === 'lerna' || manager === 'nx'
  const positional: Word[] = []
  for (let index = 0; index < args.length; index++) {
    const option = args[index].text
    if (args[index].dynamic) {
      return { bodies: [], command: null, unknown: `${manager} runs something named when it runs` }
    }
    if (option === '--') {
      positional.push(...args.slice(index + 1))
      break
    }
    if (!option.startsWith('-')) {
      positional.push(args[index])
      continue
    }
    const [base] = option.split('=')
    if (/^(-r|--recursive|--filter|-F|--workspaces|-ws|--workspace|-w|--scope|--projects|-p)$/.test(base)) {
      // A workspace filter selects packages; their scripts are all read. The value is a package name, not a script.
      workspaces = true
      if (!option.includes('=') && /^(--filter|-F|--workspace|--scope|--projects|-p)$/.test(base) && !(manager === 'pnpm' && base === '-w')) {
        index++
      }
      continue
    }
    if (/^(-C|--dir|--prefix|--cwd)$/.test(base)) {
      const value = option.includes('=') ? option.slice(base.length + 1) : args[++index]?.text
      if (value === undefined) {
        return { bodies: [], command: null, unknown: `${manager} runs in a folder BusyBoy cannot read` }
      }
      folder = resolve(folder, value)
    }
  }

  const [first, second, third] = positional.map(({ text }) => text)
  let names: string[] = []
  let command: Word[] | null = null
  if (manager === 'yarn' && first === 'workspace') {
    // `yarn workspace <package> <script or binary> …`: the rest also runs as a command.
    workspaces = true
    names = third ? [third] : []
    command = positional.slice(2)
  } else if (manager === 'turbo' || manager === 'lerna') {
    names = first === 'run' ? positional.slice(1).map(({ text }) => text).filter((text) => !text.startsWith('-')) : first ? [first] : []
  } else if (manager === 'nx') {
    // `nx run <project>:<target>`, `nx run-many -t <target>`, or `nx <target> <project>`.
    const target = first === 'run' ? second?.split(':')[1] : first === 'run-many' || first === 'affected' ? args.find((word, at) => args[at - 1]?.text === '-t' || args[at - 1]?.text === '--target')?.text : first
    names = target ? [target] : []
  } else if (first !== undefined && INSTALLS.has(first)) {
    names = ['preinstall', 'install', 'postinstall', 'prepare']
  } else if (first !== undefined && /^(run|run-script|rum|urn)$/.test(first)) {
    names = second ? [second] : []
  } else if (manager === 'npm') {
    names = first && NPM_SCRIPT_ALIASES[first] ? [NPM_SCRIPT_ALIASES[first]] : []
  } else if (first !== undefined && !(manager === 'bun' ? BUN_COMMANDS : PACKAGE_MANAGER_COMMANDS).has(first)) {
    names = [NPM_SCRIPT_ALIASES[first] ?? first]
  }

  const folders = workspaces ? packageFolders(folder) : [folder]
  if (folders === null) {
    return { bodies: [], command, unknown: `${manager} runs scripts in more packages than BusyBoy reads` }
  }
  const bodies = folders.flatMap((packageFolder) => {
    let scripts: Record<string, unknown> = {}
    try {
      scripts = (JSON.parse(readFileSync(join(packageFolder, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {}
    } catch {
      // No readable package.json: the command fails, or runs a binary that is matched as itself.
    }
    const keys = names.length === 4 && names[0] === 'preinstall' ? names : names.flatMap((name) => [`pre${name}`, name, `post${name}`])
    return keys.map((key) => scripts[key]).filter((body): body is string => typeof body === 'string').map((body) => ({ body, cwd: packageFolder }))
  })
  return { bodies, command, unknown: null }
}

/** Reads a command line into the commands it runs, following `cd`, substitutions, `-c` strings, `eval`, scripts, and package scripts. */
function analyze(script: string, context: Context): Analysis {
  if (context.depth > MAX_DEPTH) {
    return unknownOnly('it hands off to other commands too many times to follow')
  }
  if (++run.steps > MAX_STEPS) {
    return unknownOnly('it runs more commands than BusyBoy reads at once')
  }
  const { commands, substitutions, heredocs } = tokenize(script)
  const deeper = { ...context, depth: context.depth + 1 }
  return merge([...substitutions.map((inner) => analyze(inner, deeper)), analyzeCommands(commands, context, heredocs)])
}

/** Commands that only read the arguments xargs adds, so `… | xargs <command>` can run without asking. */
const XARGS_SAFE = new Set(['grep', 'egrep', 'fgrep', 'rg', 'wc', 'cat', 'head', 'tail', 'ls', 'echo', 'stat', 'file', 'basename', 'dirname', 'printf', 'sort', 'uniq', 'du', 'md5', 'md5sum', 'shasum', 'sha256sum', 'realpath', 'readlink', 'test', 'true'])

/**
 * Interpreters that run code given on the command line. `flags`: the options that take the code.
 * `before`: the one-letter options that may share a word with the code's (`perl -lne`, `node -pe`,
 * `python3 -uc`). `modules`: what the code may load and still be read, since these only compute,
 * format, and tell the time; any other module could bring in a way to run a command. The lists are
 * per language because a name safe in one (`util` in Node) is a project file in another.
 * AppleScript has no entry to read by (osascript always asks): it drives other apps in plain
 * words no word list covers.
 */
const INLINE_CODE: Record<string, { flags: string[]; before?: string; modules?: string[] }> = {
  node: { flags: ['-e', '-p', '--eval', '--print'], before: 'ep', modules: ['path', 'util', 'url', 'crypto', 'assert'] },
  deno: { flags: ['eval'] },
  python: {
    flags: ['-c'],
    before: 'uBsSEIOq',
    modules: [
      'json', 'sys', 'time', 're', 'math', 'datetime', 'base64', 'hashlib', 'random', 'collections', 'itertools', 'functools', 'string',
      'textwrap', 'statistics', 'decimal', 'fractions', 'uuid', 'html', 'unicodedata', 'pprint', 'operator', 'binascii', 'struct',
      'calendar', 'zlib', 'csv', 'difflib',
    ],
  },
  // `-n`, `-p`, `-l`, `-a`, and `-0` loop over input lines; `-i` edits the files given in place.
  perl: { flags: ['-e', '-E'], before: 'nplawi0-7', modules: ['strict', 'warnings', 'utf8', 'feature', 'Time::HiRes', 'JSON::PP', 'List::Util', 'Data::Dumper'] },
  ruby: { flags: ['-e'], before: 'nplawi0-7', modules: ['json', 'time', 'date', 'set'] },
  php: { flags: ['-r'] },
  osascript: { flags: ['-e'] },
  lua: { flags: ['-e'] },
}

/** `python3.12` and `python3` are `python`; Bun and the TypeScript runners take Node's options. */
const interpreterOf = (name: string) => {
  const plain = name.replace(/[\d.]+$/, '')
  return plain === 'bun' || plain === 'tsx' || plain === 'ts-node' ? 'node' : plain
}

/**
 * Calls that let inline code run a command, load code, reach the network, or delete.
 * Matched on the code with comments and string literals taken out, and only as whole
 * words, so `requestId`, `filesystem`, or the word "delete" inside a string does not ask.
 * `execSync` and `spawnSync` are the same call as `exec` and `spawn`.
 */
const INLINE_RUNS =
  /\b(?:exec(?:Sync|File|FileSync|vp|v)?|spawn(?:Sync)?|system|popen|proc_open|readpipe|fork|eval|subprocess|child_process|shutil|remove|delete|rmtree|rmdir|socket|sock|https?|fetch|urllib|request|ctypes|pickle|marshal|syscall|passthru|dofile|loadfile|loadstring|include|getattr|globals|builtins|binding|dlopen|kill|worker|constructor|mainmodule|import|require)\b|link\b|open[^;]*\||__|`|\bqx\b|%x|\bload\s*\(?\s*['"]|\b(?:use|do|os|fs|io|net|tls|dns|dgram|cluster|repl|inspector|vm|sh|deno|bun|mail|rm\w*|mv|cp)\b/i

/**
 * Comments and string literals masked out of inline code, so a word that only
 * appears in one of them is not read as a call. `part` chooses which of the two
 * to mask; the other is copied through. Interpolation (`${…}`, `#{…}`, and the
 * `{…}` of a Python f-string) is code, so it is kept and masked on its own.
 */
function maskCode(code: string, interpreter: string, part: 'comments' | 'strings') {
  const hashComment = part === 'comments' && (interpreter === 'python' || interpreter === 'perl' || interpreter === 'ruby' || interpreter === 'php')
  const slashComment = part === 'comments' && (interpreter === 'node' || interpreter === 'php')
  const dashComment = part === 'comments' && interpreter === 'lua'
  const blankBacktick = part === 'strings' && interpreter !== 'perl' && interpreter !== 'ruby' && interpreter !== 'php'
  let out = ''
  for (let index = 0; index < code.length; ) {
    if (interpreter === 'python' && (code.startsWith('"""', index) || code.startsWith("'''", index))) {
      const quote = code.slice(index, index + 3)
      const end = code.indexOf(quote, index + 3)
      const stop = end === -1 ? code.length : end + 3
      out += part === 'strings' ? ' '.repeat(stop - index) : code.slice(index, stop)
      index = stop
      continue
    }
    const quote = code[index]
    if (quote === '"' || quote === "'" || quote === '`') {
      const blank = part === 'strings' && (quote !== '`' || blankBacktick)
      const stop = blank ? blankString(code, index, quote, interpreter) : copyString(code, index, quote)
      out += stop.text
      index = stop.end
      continue
    }
    const comment =
      (hashComment && quote === '#') || (slashComment && code.startsWith('//', index)) || (dashComment && code.startsWith('--', index)) || (slashComment && code.startsWith('/*', index))
    if (comment) {
      const block = code.startsWith('/*', index)
      const end = block ? code.indexOf('*/', index + 2) : code.indexOf('\n', index)
      const stop = end === -1 ? code.length : end + (block ? 2 : 0)
      out += ' '.repeat(stop - index)
      index = stop
      continue
    }
    out += quote
    index++
  }
  return out
}

/** The end of a quoted string whose contents are copied through, so a later pass can still see them. */
function copyString(code: string, start: number, quote: string) {
  let index = start + 1
  while (index < code.length && code[index] !== quote) index += code[index] === '\\' ? 2 : 1
  const end = Math.min(index + 1, code.length)
  return { text: code.slice(start, end), end }
}

/** A quoted string replaced with spaces, with the code inside its interpolation kept. */
function blankString(code: string, start: number, quote: string, interpreter: string) {
  const pythonF = interpreter === 'python' && /[fF]$/.test(code.slice(Math.max(0, start - 1), start))
  const ruby = interpreter === 'ruby' && quote === '"'
  const template = quote === '`' && interpreter === 'node'
  let text = ' '
  let index = start + 1
  while (index < code.length) {
    if (code[index] === '\\') {
      text += '  '
      index += 2
      continue
    }
    const interp = (template && code.startsWith('${', index)) || (ruby && code.startsWith('#{', index)) || (pythonF && code[index] === '{' && code[index + 1] !== '{')
    if (interp) {
      const mark = pythonF ? 1 : 2
      let depth = 1
      let cursor = index + mark
      const bodyStart = cursor
      while (cursor < code.length && depth > 0) {
        if (code[cursor] === '{') depth++
        else if (code[cursor] === '}') depth--
        if (depth > 0) cursor++
      }
      text += ' '.repeat(mark) + maskCode(code.slice(bodyStart, cursor), interpreter, 'strings') + ' '
      index = Math.min(cursor + 1, code.length)
      continue
    }
    text += ' '
    if (code[index] === quote) return { text, end: index + 1 }
    index++
  }
  return { text, end: code.length }
}

/** JavaScript's `Function('code')`, told apart from a `function (x) {}` callback by its capital. */
const INLINE_FUNCTION = /\bFunction\s*\(/

/**
 * A pipe opened by Perl or Ruby (`open "|cmd"`, `open $p, "-|"`) and Ruby's
 * `load "file"`. The mode and the path sit in a string, so they are checked
 * before strings are masked out.
 */
const OPENS_COMMAND = /\bopen\s*\([^;]*['"]\s*(?:\|-?|-\|)|\bload\s*\(?\s*['"]/

/** Words that let inline code change a file, which a subagent may not do without asking. */
const INLINE_WRITES = /open|write|append|truncate|rename|copy|move|mkdir|chmod|chown|touch|put_contents|utime|file\.new|splfileobject/i

/**
 * The code an interpreter is given on its command line, with the module loads, file reads, and
 * terminal writes known to be harmless taken out. Undefined when the command gives no code this
 * way, and null when the code cannot be read: built when it runs, given with an option not known
 * here (`node -r`, `perl -M`), or loading any other module. `strict`: only where the interpreter
 * itself takes the option, before its first plain word, so `node gen.mjs -p 3000` is not code.
 */
function inlineCode(name: string, args: Word[], strict = false) {
  const interpreter = interpreterOf(name)
  const known = INLINE_CODE[interpreter]
  if (!known) {
    return undefined
  }
  const { flags, before, modules = [] } = known
  const letters = flags.filter((flag) => /^-\w$/.test(flag)).map((flag) => flag[1]).join('')
  const bundled = before && letters ? new RegExp(`^-([${before}]*)[${letters}]$`) : null
  const loop = before && letters ? new RegExp(`^-[${before}]+$`) : null
  const codes: string[] = []
  let operand = false
  let unreadable = false
  for (let index = 0; index < args.length; index++) {
    const { text } = args[index]
    const long = flags.find((flag) => flag.startsWith('--') && text.startsWith(`${flag}=`))
    const exact = interpreter === 'deno' ? index === 0 && text === 'eval' : flags.includes(text)
    const switches = operand ? null : (bundled?.exec(text)?.[1] ?? (loop?.test(text) ? text.slice(1) : null))
    if (long) {
      // `--eval=code` carries its code in the option itself.
      codes.push(text.slice(long.length + 1))
    } else if (exact || (switches !== null && bundled?.test(text))) {
      if (operand && strict) {
        return undefined
      }
      codes.push(args[++index]?.text ?? '')
    } else if (!operand && letters && new RegExp(`^-[${letters}].`).test(text)) {
      // `-e'code'` reaches here as one word, `-ecode`.
      codes.push(text.slice(2))
    } else if (switches === null && text.startsWith('-') && !operand) {
      unreadable = true
    } else if (!text.startsWith('-')) {
      // The words after this are the code's own arguments, or files a line loop reads.
      operand = true
    }
    if (switches?.includes('i') && (interpreter === 'perl' || interpreter === 'ruby')) {
      codes.push('write')
    }
  }
  if (codes.length === 0 || (strict && interpreter === 'deno' && args[0]?.text !== 'eval')) {
    return undefined
  }
  if (interpreter === 'osascript' || unreadable || args.some((word) => word.dynamic)) {
    return null
  }
  let unknownModule = false
  const load = (...loaded: string[]) => {
    // A JSON file holds no code, whichever package it is in.
    unknownModule ||= loaded.some((module) => !modules.includes(module.replace(/^node:/, '')) && !/^[\w@./-]+\.json$/.test(module))
    return ' '
  }
  // Comments go first, so an import written in one is not a module the code loads.
  // Strings go last, so a read of a file (`open('package.json')`) is still recognized
  // before the words inside strings stop counting as calls.
  const read = maskCode(codes.join('\n'), interpreter, 'comments')
    // Reading a file the usual ways (Python's one-argument open, Node's readFileSync), and
    // printing through the terminal's own streams.
    .replace(/\bopen\(\s*(['"])[^'"|<>]*\1\s*\)/g, ' ')
    .replace(/\brequire\((['"])(?:node:)?fs\1\)\.readFileSync\b/g, ' ')
    .replace(/\bstd(?:out|err)\.write\b/g, ' ')
    .replace(/\bfrom\s+([\w.]+)\s+import\b/g, (_, module: string) => load(module))
    .replace(/\bimport\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/g, (_, list: string) =>
      load(...list.split(',').map((item) => item.trim().split(/\s+/)[0])),
    )
    .replace(/\brequire\s*\(?\s*(['"])([^'"]+)\1\s*\)?/g, (_, _quote: string, module: string) => load(module))
    .replace(/\buse\s+([\w:]+)/g, (_, module: string) => load(module))
  // A pipe or a loaded file is named inside a string. Masking that string would hide it.
  if (unknownModule || OPENS_COMMAND.test(read)) return null
  return maskCode(read, interpreter, 'strings')
}

/** Git's global options, which come before the subcommand; any other option there cannot be read. */
const GIT_GLOBAL_OPTIONS =
  /^(-C|-c|-p|-P|--paginate|--no-pager|--git-dir|--work-tree|--namespace|--bare|--exec-path|--config-env|--no-replace-objects|--no-lazy-fetch|--no-optional-locks|--no-advice|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--attr-source|--super-prefix|--list-cmds|--html-path|--man-path|--info-path|--version|-v|--help|-h)$/

/** Git subcommands that are not aliases, so only other names are looked up in the git config. */
const GIT_COMMANDS = new Set([
  'add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'checkout', 'cherry', 'cherry-pick', 'clean', 'clone', 'commit',
  'config', 'describe', 'diff', 'fetch', 'format-patch', 'gc', 'grep', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge',
  'merge-base', 'mv', 'notes', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote', 'reset', 'restore', 'rev-list', 'rev-parse',
  'revert', 'rm', 'shortlog', 'show', 'show-ref', 'sparse-checkout', 'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag',
  'update-ref', 'var', 'version', 'worktree', 'help', 'cat-file', 'check-ignore', 'count-objects', 'for-each-ref', 'fsck', 'hash-object',
  'lfs', 'maintenance', 'merge-tree', 'name-rev', 'prune', 'read-tree', 'repack', 'replace', 'request-pull', 'send-email', 'whatchanged',
])

/** Checks commands already split into words, in order, keeping track of `cd`. */
function analyzeCommands(commands: Word[][], context: Context, heredocs: string[][] = []): Analysis {
  const deeper = (cwd: string | null) => ({ ...context, cwd, depth: context.depth + 1 })
  const results: Analysis[] = []
  let cwd = context.cwd

  for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
    const written = commands[commandIndex]!
    const unwrapped = unwrap(written)
    if (!unwrapped) {
      results.push(unknownOnly('it sets PATH or a git variable, or passes a wrapper command an option BusyBoy does not know'))
      continue
    }
    const { viaXargs } = unwrapped
    let { argv } = unwrapped
    if (argv.length === 0) {
      continue
    }
    if (argv[0].dynamic) {
      // In a file, a command from a variable is usually a tool path ($(CC), $NODE); on a command line it could be anything.
      // A file's `$(GIT) push` or `$DEPLOY_CLI deploy` names an action that cannot be checked without the variable.
      if (!context.scan || argv.slice(1).some(({ text }) => /^(push|deploy|publish|merge|delete|destroy|apply|up|release)$/.test(text))) {
        results.push(unknownOnly('it runs a command built from a variable or a substitution'))
      }
      continue
    }
    if (argv[0].text.startsWith(':::')) {
      results.push(unknownOnly('parallel runs commands given as its arguments'))
      continue
    }

    const name = basename(argv[0].text)
    const args = argv.slice(1)
    const pathOf = (word: Word | undefined) => (word && !word.dynamic && cwd !== null ? resolve(cwd, word.text) : null)

    if (viaXargs && !context.scan && !XARGS_SAFE.has(name) && !DELETERS.has(name)) {
      // xargs adds arguments read from its input, which cannot be seen here (`xargs git` could push).
      results.push(unknownOnly('xargs adds arguments BusyBoy cannot see'))
    }
    // Inline code that only computes, prints, reads, and waits (a JSON one-liner, a short sleep
    // in a polling loop) runs like a script file does; anything more asks.
    const code = inlineCode(name, args)
    if (code === null || (code !== undefined && (INLINE_RUNS.test(code) || INLINE_FUNCTION.test(code)))) {
      results.push(unknownOnly(`${name} runs inline code BusyBoy cannot tell is harmless`))
      continue
    }
    if ((name === 'awk' || name === 'gawk' || name === 'nawk') && args.some(({ text }) => /system\s*\(|\|\s*"|"\s*\|/.test(text))) {
      results.push(unknownOnly('awk runs commands from its program'))
      continue
    }
    if ((name === 'ssh' && args.filter(({ text }) => !text.startsWith('-')).length > 1) || ((name === 'tmux' || name === 'screen') && args.some(({ text }) => /^(new|new-session|new-window|split-window|send-keys|send|run-shell|run|respawn-pane|-dm|-d)$/.test(text)))) {
      results.push(unknownOnly(`${name} runs a command BusyBoy does not read`))
      continue
    }
    if (context.scan && context.file && (name === 'include' || name === 'sinclude')) {
      // A Makefile's `include other.mk` adds that file's recipes.
      const base = dirname(context.file)
      results.push(merge(args.filter((word) => !word.dynamic).map((word) => analyzeFile(resolve(base, word.text), deeper(cwd)))))
      continue
    }
    if (name === 'alias') {
      // `alias p='git push -f'; p` runs the alias later in the line: its value is checked as a command line.
      for (const word of args) {
        const value = /^[^=]+=(.*)$/s.exec(word.text)?.[1]
        if (value !== undefined) {
          results.push(word.dynamic ? unknownOnly('it defines an alias decided when it runs') : analyze(value, deeper(cwd)))
        }
      }
      continue
    }
    if ((name === 'export' || name === 'declare' || name === 'typeset' || name === 'readonly') && args.some((word) => RISKY_VARIABLE.test(word.text))) {
      results.push(unknownOnly('it sets PATH or a git variable for the commands after it'))
      continue
    }
    if (name === 'cd' || name === 'pushd') {
      const target = args.find((word) => !word.text.startsWith('-'))
      // `~` and `~/x` are the home folder; `~user` is someone else's, which is not looked up.
      const home = target && !target.dynamic && /^~(?=\/|$)/.test(target.text) ? join(homedir(), target.text.slice(1)) : null
      cwd = !target ? cwd : home ?? (target.dynamic || target.text.startsWith('~') || cwd === null ? null : resolve(cwd, target.text))
      continue
    }
    if (SHELLS.has(name)) {
      const flag = args.findIndex((word) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word.text))
      if (flag !== -1) {
        const inner = args.slice(flag + 1).find((word) => word.text !== '--')
        results.push(!inner || inner.dynamic ? unknownOnly(`${name} -c runs a script decided when it runs`) : analyze(inner.text, deeper(cwd)))
        continue
      }
      const file = args.find((word) => !word.text.startsWith('-') && !word.text.startsWith('+'))
      if (!file) {
        if (!context.scan) {
          results.push(unknownOnly(`${name} runs a script read from its input`))
        }
        continue
      }
      const path = pathOf(file)
      if (path === null || (readScript(path) === null && !context.scan)) {
        // A script that cannot be read (decided when it runs, a <(…) stream, or missing) could run anything.
        results.push(unknownOnly(`${name} runs a script BusyBoy cannot read`))
        continue
      }
      results.push(analyzeFile(path, deeper(cwd)))
      continue
    }
    if (name === 'eval') {
      results.push(
        args.some((word) => word.dynamic) ? unknownOnly('eval runs a command built when it runs') : analyze(args.map(({ text }) => text).join(' '), deeper(cwd)),
      )
      continue
    }
    if (name === 'source' || name === '.') {
      const path = pathOf(args[0])
      results.push(path === null ? unknownOnly(`${name} reads a script whose path is decided when it runs`) : analyzeFile(path, deeper(cwd)))
      continue
    }
    if (/^(npm|pnpm|yarn|bun|turbo|lerna|nx)$/.test(name) && cwd !== null) {
      const { bodies, command, unknown } = packageScripts({ manager: name, args, cwd })
      results.push(unknown ? unknownOnly(unknown) : merge(bodies.map(({ body, cwd: scriptCwd }) => analyze(body, deeper(scriptCwd)))))
      if (command && command.length > 0) {
        results.push(analyzeCommands([command], deeper(cwd)))
      }
    }
    if (name === 'just' && cwd !== null) {
      // A justfile's recipes are command lines, read like a Makefile's. The folder is the agent's,
      // known only when it runs; without the ignore comment Turbopack traces the whole project.
      const path = ['justfile', 'Justfile', '.justfile'].map((file) => join(/*turbopackIgnore: true*/ cwd as string, file)).find((file) => readScript(file) !== null)
      if (path) {
        results.push(analyzeFile(path, deeper(cwd)))
      }
    }
    if ((name === 'npx' || name === 'npm') && args.some(({ text }) => text === '-c' || text === '--call')) {
      // `npx -c '<command>'` and `npm exec -c` run a command line.
      const flag = args.findIndex(({ text }) => text === '-c' || text === '--call')
      const inner = args[flag + 1]
      results.push(!inner || inner.dynamic ? unknownOnly(`${name} -c runs a command decided when it runs`) : analyze(inner.text, deeper(cwd)))
    }
    if (name === 'find') {
      // Each -exec/-execdir/-ok runs the words up to `;` or `+` as a command.
      for (let index = 0; index < args.length; index++) {
        if (/^-(exec|execdir|ok|okdir)$/.test(args[index].text)) {
          const end = args.findIndex((word, at) => at > index && (word.text === ';' || word.text === '+'))
          results.push(analyzeCommands([args.slice(index + 1, end === -1 ? undefined : end)], deeper(cwd)))
        }
      }
    }
    if ((name === 'make' || name === 'gmake') && cwd !== null) {
      let folder = cwd
      let makefile: string | null = null
      for (let index = 0; index < args.length; index++) {
        const option = args[index].text
        // `-C dir`, `-Cdir`, and `--directory=dir`; the same forms for the makefile.
        const value = (short: string, long: string) =>
          option === short || option === long ? (args[++index]?.text ?? null) : option.startsWith(`${long}=`) ? option.slice(long.length + 1) : option.startsWith(short) && option.length > 2 ? option.slice(2) : undefined
        const directory = value('-C', '--directory')
        const file = directory === undefined ? (value('-f', '--file') ?? value('-f', '--makefile')) : undefined
        if (directory !== undefined && directory !== null) {
          folder = resolve(folder, directory)
        } else if (file !== undefined) {
          makefile = file
        }
      }
      const path = makefile
        ? resolve(folder, makefile)
        : // Ignored for tracing like the justfile above: the folder is known only when the agent runs.
          ['GNUmakefile', 'makefile', 'Makefile'].map((file) => join(/*turbopackIgnore: true*/ folder, file)).find((file) => readScript(file) !== null)
      if (path) {
        results.push(analyzeFile(path, deeper(folder)))
      }
    }
    if (argv[0].text.includes('/') && cwd !== null) {
      // A script run by its path, such as ./deploy.sh: its text is checked. A binary is matched as itself.
      results.push(analyzeFile(resolve(cwd, argv[0].text), deeper(cwd)))
    }

    // `/usr/bin/git` is still `git`, and git's global options do not change the subcommand.
    // `hub` wraps git, and `git-push` is git's own push program.
    const gitProgram = /^git-(push|send-pack)$/.exec(name)
    argv = gitProgram ? [literal('git'), literal(gitProgram[1]), ...args] : [{ ...argv[0], text: name === 'hub' ? 'git' : name }, ...args]
    let gitDir: Word | null = null
    if (argv[0].text === 'git') {
      let index = 1
      let inlineAlias = false
      while (index < argv.length && argv[index].text.startsWith('-')) {
        const option = argv[index].text
        if (option === '-C') {
          gitDir = argv[index + 1] ?? null
        }
        // `git -c alias.p='push -f' p` defines a command on the spot; an option git does not list could change what runs.
        inlineAlias ||=
          ((option === '-c' || option === '--config-env') && /^alias\./i.test(argv[index + 1]?.text ?? '')) ||
          option.startsWith('--exec-path') ||
          !GIT_GLOBAL_OPTIONS.test(option.split('=')[0])
        // These options take the next word as their value.
        index += /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--attr-source|--super-prefix|--list-cmds)$/.test(option) ? 2 : 1
      }
      argv = [argv[0], ...argv.slice(index)]
      // `git subtree push` and `git send-pack` push like `git push`.
      if ((argv[1]?.text === 'subtree' && argv[2]?.text === 'push') || argv[1]?.text === 'send-pack') {
        argv = [argv[0], literal('push'), ...argv.slice(argv[1].text === 'subtree' ? 3 : 2)]
      }
      const sub = argv[1]
      // `git rebase -x <cmd>` and `git submodule foreach <cmd>` run a command line.
      const runs =
        sub?.text === 'rebase'
          ? argv.filter((_, at) => /^(-x|--exec)$/.test(argv[at - 1]?.text ?? '')).concat(argv.filter(({ text }) => text.startsWith('--exec=')).map((word) => ({ ...word, text: word.text.slice(7) })))
          : sub?.text === 'submodule' && argv[2]?.text === 'foreach'
            ? argv.slice(3).filter(({ text }) => !text.startsWith('-')).slice(0, 1)
            : []
      for (const inner of runs) {
        results.push(inner.dynamic ? unknownOnly('git runs a command decided when it runs') : analyze(inner.text, deeper(cwd)))
      }
      if (inlineAlias || sub?.dynamic) {
        results.push(unknownOnly('it runs a git command defined or named on the spot'))
      } else if (sub && !GIT_COMMANDS.has(sub.text) && cwd !== null) {
        // A git alias from the user's or the repository's config runs what it names.
        const folder = gitDir && !gitDir.dynamic ? resolve(cwd, gitDir.text) : cwd
        const alias = git({ cwd: folder, args: ['config', '--get', `alias.${sub.text}`] })
        if (alias) {
          const expanded = alias.startsWith('!') ? alias.slice(1) : `git ${alias}`
          const { commands: aliasCommands, substitutions, heredocs: aliasHeredocs } = tokenize(expanded)
          const last = aliasCommands.at(-1)
          if (last) {
            last.push(...argv.slice(2))
          }
          results.push(merge([...substitutions.map((inner) => analyze(inner, deeper(folder))), analyzeCommands(aliasCommands, deeper(folder), aliasHeredocs)]))
        }
      }
    }
    // `apply_patch <<'EOF'` and `apply_patch '{"command":[...patch...]}'` name files in the
    // heredoc or the argument. The diff text is not a shell command.
    const patchTool = argv[0]?.text === 'apply_patch' || argv[0]?.text === 'applypatch'
    const patches = patchTool ? filesInPatch([...(heredocs[commandIndex] ?? []), ...argv.slice(1).map(({ text }) => text)]) : []
    results.push({ facts: [{ written, argv, cwd, viaXargs, gitDir, scan: context.scan, patches }], unknown: null })
  }
  return merge(results)
}

/** A Codex argv such as `["bash", "-lc", "git push"]`, as one command line. */
function argvToScript(argv: string[]) {
  // One element that already contains a command line (`["git push --force"]`), which is how a
  // JSON-wrapped call and some Codex payloads arrive. An argument list has no spaces in its words.
  if (argv.length === 1 && /[\s;&|<>]/.test(argv[0] ?? '')) return argv[0]
  const [first] = argv
  if (first && SHELLS.has(basename(first))) {
    const flag = argv.findIndex((part, index) => index > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(part))
    const inner = flag === -1 ? undefined : argv.slice(flag + 1).find((part) => part !== '--')
    if (inner !== undefined) {
      return inner
    }
  }
  return argv.map((part) => `'${part.replaceAll("'", `'\\''`)}'`).join(' ')
}

/** The command text a shell tool carries, under the field names Claude and Codex use. */
function commandField(input: unknown) {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  return record.command ?? record.cmd ?? record.command_line ?? record.commandLine
}

/** The command line a shell tool runs, or null for any other tool. */
export function shellCommand(toolName: string, input: unknown) {
  if (!isShellTool(toolName)) return null
  const command = commandField(input)
  if (typeof command === 'string') return command
  // Codex can pass its command as an argument list.
  return Array.isArray(command) && command.every((part) => typeof part === 'string') ? argvToScript(command) : null
}

const PATCH_KINDS: Record<string, PatchFile['kind']> = { 'add file': 'add', 'update file': 'update', 'delete file': 'delete', 'move to': 'move' }

/**
 * The files a patch names. The patch may be the raw apply_patch grammar, a heredoc
 * body, or the JSON wrapper Codex sometimes puts around it (`{"command":["apply_patch","*** Begin Patch…"]}`),
 * with newlines written as the two characters `\\n`.
 */
function filesInPatch(parts: string[], depth = 0): PatchFile[] {
  if (depth > 4) return []
  const found: PatchFile[] = []
  const header = /^[ \t]*\*{3,}[ \t]+(Add File|Update File|Delete File|Move to):[ \t]*(.+?)[ \t]*$/gim
  const fromText = (part: string) => {
    const files: PatchFile[] = []
    for (const match of part.matchAll(header)) {
      const kind = PATCH_KINDS[match[1].toLowerCase()]
      const path = match[2].trim().replace(/^['"]|['"]$/g, '')
      if (kind && path) files.push({ path, kind })
    }
    return files
  }
  for (const part of parts) {
    if (!part || part.length > 1_000_000) continue
    const direct = fromText(part)
    if (direct.length > 0) {
      found.push(...direct)
      continue
    }
    const trimmed = part.trim()
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 1_000_000) {
      try {
        const walk = (value: unknown, level: number) => {
          if (level > 6) return
          if (typeof value === 'string') found.push(...filesInPatch([value], depth + 1))
          else if (Array.isArray(value)) for (const item of value) walk(item, level + 1)
          else if (value && typeof value === 'object') for (const item of Object.values(value)) walk(item, level + 1)
        }
        walk(JSON.parse(trimmed) as unknown, 0)
        continue
      } catch {
        // The text is a patch, not JSON. A backslash-n below may still be its newlines.
      }
    }
    // Newlines written as the two characters `\` and `n`, outside a JSON string.
    if (part.includes('\\n')) found.push(...filesInPatch([part.replace(/\\n/g, '\n').replace(/\\t/g, '\t')], depth + 1))
  }
  return found
}

/** A fact for a patch tool call, whose input is the patch rather than a shell command. */
function patchAnalysis(input: unknown, folder: string): Analysis {
  const text = typeof input === 'string' ? input : commandField(input)
  const extra = input && typeof input === 'object' ? Object.values(input as Record<string, unknown>).filter((value): value is string => typeof value === 'string') : []
  const patches = filesInPatch([...(typeof text === 'string' ? [text] : []), ...extra])
  if (patches.length === 0) return NOTHING
  return { facts: [{ written: [], argv: [], cwd: folder, viaXargs: false, gitDir: null, scan: false, patches }], unknown: null }
}

/**
 * Whether `text` matches `glob`, where `*` matches any characters, ignoring case.
 * Matched part by part, never with a regular expression, so a rule with many
 * `*` cannot make a long command take exponential time.
 */
function globMatches({ glob, text }: { glob: string; text: string }) {
  const parts = glob.toLowerCase().split('*')
  const subject = text.toLowerCase()
  const first = parts[0]
  const last = parts.at(-1) ?? ''
  if (parts.length === 1) {
    return subject === first
  }
  if (!subject.startsWith(first) || !subject.endsWith(last) || subject.length < first.length + last.length) {
    return false
  }
  // The middle parts, in order, each at its earliest place; the earliest place always leaves the most room.
  let position = first.length
  for (const part of parts.slice(1, -1)) {
    const found = subject.indexOf(part, position)
    if (found === -1 || found + part.length > subject.length - last.length) {
      return false
    }
    position = found + part.length
  }
  return true
}

const joined = (words: Word[]) => words.map(({ text }) => text).join(' ')

/** Options of `git push` that take the next word as their value. */
const PUSH_VALUE_OPTIONS = /^(--repo|--receive-pack|--exec|-o|--push-option)$/

const isPush = ({ argv }: Fact) => argv[0]?.text === 'git' && argv[1]?.text === 'push'

/** Whether `--<name>` spells one of `options`, which git also accepts shortened to any unambiguous prefix (`--mirr`). */
const spells = ({ text, options }: { text: string; options: string[] }) => {
  const name = text.slice(2).split('=')[0]
  return text.startsWith('--') && name.length >= 2 && options.some((option) => option.startsWith(name) || name.startsWith(option))
}

/** Whether `gh api` writes a git ref: a method other than GET, or fields, which make it a POST. */
function writesRef({ argv }: Fact) {
  if (argv[0]?.text !== 'gh' || argv[1]?.text !== 'api' || !argv.some(({ text }) => /git\/refs/.test(text))) {
    return false
  }
  return argv.some(({ text }, at) => {
    const method = /^(-X|--method)$/.test(argv[at - 1]?.text ?? '') ? text : /^(-X|--method=)(.+)$/.exec(text)?.[2]
    return (method !== undefined && method.toUpperCase() !== 'GET') || /^(-f|-F|--field|--raw-field|--input)/.test(text)
  })
}

/** `git push` that rewrites or deletes remote history: forced, mirrored, a `+` or `:` refspec, or a delete; or a ref written through `gh api`. */
function isForcePush(fact: Fact) {
  if (writesRef(fact)) {
    return true
  }
  if (!isPush(fact)) {
    return false
  }
  return fact.argv.slice(2).some(({ text, dynamic }) => {
    if (spells({ text, options: ['force', 'force-with-lease', 'force-if-includes', 'mirror', 'delete'] }) || (text.startsWith('--pru') && 'prune'.startsWith(text.slice(2).split('=')[0]))) {
      return true
    }
    // A cluster of short options with `f` or `d`, such as `-uf`.
    if (/^-[a-zA-Z]+$/.test(text) && /[fd]/.test(text)) {
      return true
    }
    // On a command line, a target decided when it runs could be forced.
    return /^[+:]/.test(text) || (dynamic && !fact.scan)
  })
}

function git({ cwd, args }: { cwd: string; args: string[] }) {
  const key = JSON.stringify([cwd, args])
  if (!run.git.has(key)) {
    let answer: string | null
    try {
      answer = execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      answer = null
    }
    run.git.set(key, answer)
  }
  return run.git.get(key) ?? null
}

/** Whether a `git push` updates the remote's default branch: main, master, or the branch its HEAD names. */
function pushesDefaultBranch(fact: Fact) {
  if (!isPush(fact)) {
    return false
  }
  if (fact.argv.some(({ text }) => text === '--all' || text === '--branches' || text === '--mirror')) {
    return true
  }
  const positional: Word[] = []
  for (let index = 2; index < fact.argv.length; index++) {
    if (PUSH_VALUE_OPTIONS.test(fact.argv[index].text)) {
      index++
    } else if (!fact.argv[index].text.startsWith('-')) {
      positional.push(fact.argv[index])
    }
  }
  const [remote, ...refspecs] = positional
  // A target decided when the command runs, on a command line or in a script, could be the default branch.
  if (remote?.dynamic || refspecs.some(({ dynamic }) => dynamic)) {
    return true
  }
  const folder = fact.gitDir && !fact.gitDir.dynamic && fact.cwd ? resolve(fact.cwd, fact.gitDir.text) : fact.cwd
  const defaults = new Set(['main', 'master'])
  const head = folder ? git({ cwd: folder, args: ['symbolic-ref', '--short', `refs/remotes/${remote?.text ?? 'origin'}/HEAD`] }) : null
  if (head) {
    defaults.add(head.replace(/^[^/]+\//, ''))
  }
  // A configured push refspec (remote.<name>.push) can send any branch to the default one.
  const configured = folder ? git({ cwd: folder, args: ['config', '--get-all', `remote.${remote?.text ?? 'origin'}.push`] }) : null
  if (refspecs.length === 0 && configured?.split('\n').some((refspec) => defaults.has(refspec.split(':').at(-1)?.replace(/^refs\/heads\//, '') ?? ''))) {
    return true
  }
  // With no refspec, git pushes where push.default sends the current branch, which may be an
  // upstream with another name (@{push}); HEAD as a refspec is the current branch itself.
  if (refspecs.length === 0) {
    const pushTarget = folder ? git({ cwd: folder, args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'] }) : null
    const branch = pushTarget?.replace(/^[^/]+\//, '') ?? (folder ? git({ cwd: folder, args: ['rev-parse', '--abbrev-ref', 'HEAD'] }) : null)
    return branch !== null && defaults.has(branch)
  }
  return refspecs.some(({ text }) => {
    const destination = text.replace(/^\+/, '').split(':').at(-1) ?? ''
    const branch = destination === 'HEAD' || destination === '' ? (folder ? git({ cwd: folder, args: ['rev-parse', '--abbrev-ref', 'HEAD'] }) : null) : destination
    return branch !== null && defaults.has(branch.replace(/^refs\/heads\//, ''))
  })
}

/** Whether a command deploys, publishes, or changes infrastructure, as deploy, registry, and infrastructure CLIs do. */
function deploys({ argv }: Fact) {
  const [command, sub, third] = argv.map(({ text }) => text)
  switch (command) {
    case 'vercel':
    case 'vc':
      // Options alone (`vercel --prod`, `vercel --yes`) deploy; so does a path.
      return sub === undefined || !VERCEL_LOCAL.has(sub)
    case 'netlify':
    case 'fly':
    case 'flyctl':
    case 'firebase':
      return sub === 'deploy'
    case 'wrangler':
      return sub === 'deploy' || sub === 'publish' || ((sub === 'pages' || sub === 'versions') && third === 'deploy')
    case 'npm':
    case 'pnpm':
    case 'cargo':
      return sub === 'publish'
    case 'yarn':
      return sub === 'publish' || (sub === 'npm' && third === 'publish')
    case 'gem':
    case 'docker':
      return sub === 'push'
    case 'twine':
      return sub === 'upload'
    case 'gh':
      // A workflow run is how many repositories deploy.
      return (sub === 'release' && (third === 'create' || third === 'upload' || third === 'edit')) || (sub === 'workflow' && third === 'run')
    case 'terraform':
    case 'tofu':
    case 'pulumi':
      return sub === 'apply' || sub === 'destroy' || sub === 'up' || sub === 'import'
    case 'kubectl':
      return ['apply', 'create', 'delete', 'replace', 'patch', 'scale', 'rollout', 'set', 'edit', 'drain'].includes(sub ?? '')
    case 'helm':
      return ['install', 'upgrade', 'uninstall', 'rollback', 'delete'].includes(sub ?? '')
    case 'serverless':
    case 'sls':
      return sub === 'deploy' || sub === 'remove'
    case 'railway':
      return sub === 'up' || sub === 'deploy' || sub === 'redeploy'
    case 'heroku':
      return sub !== undefined && /^(releases:rollback|apps:destroy|pg:reset|run)/.test(sub)
    case 'aws':
      if (sub === 's3') {
        return third === 'rm' || third === 'rb' || third === 'mv' || (third === 'sync' && argv.some(({ text }) => text === '--delete'))
      }
      return sub === 'cloudformation' && (third === 'deploy' || third === 'delete-stack')
    default:
      return false
  }
}

/** Whether a connector tool sends, posts, merges, publishes, or deletes, read from the words of its name. */
function isConnectorWrite(toolName: string) {
  const match = /^mcp__.+?__(.+)$/.exec(toolName)
  if (!match) {
    return false
  }
  const words = match[1]
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  if (words.some((word) => CONNECTOR_VERBS.has(word))) {
    return true
  }
  const creates = words.some((word) => word === 'create' || word === 'add' || word === 'new')
  return creates && words.some((word) => CONNECTOR_CREATED.has(word.replace(/s$/, '')))
}

/** A path with symlinks resolved in the part of it that exists, so a link inside the folder that points out is seen as outside. */
function realPath(path: string) {
  let existing = path
  while (!existsSync(existing) && dirname(existing) !== existing) {
    existing = dirname(existing)
  }
  try {
    return join(realpathSync(existing), relative(existing, path))
  } catch {
    return path
  }
}

function isOutside({ folders, fact, word }: { folders: string[]; fact: Fact; word: Word }) {
  // A home path is outside. In a file, other variables are taken as written; on a command line any
  // variable, or a folder `cd` lost track of, may be anywhere.
  if (word.text.startsWith('~') || /\$\{?HOME\b/.test(word.text) || (word.dynamic && !fact.scan) || fact.cwd === null) {
    return true
  }
  const path = resolve(fact.cwd, word.text)
  return [path, realPath(path)].some((candidate) =>
    folders.every((folder) => {
      const inside = relative(folder, candidate)
      return inside.startsWith('..') || isAbsolute(inside)
    }),
  )
}

const HERE = literal('.')

/** Whether a patch deletes, or moves away, a file outside the task folder. The move's source is the update it follows. */
function patchDeletesOutside(fact: Fact, outside: (word: Word) => boolean) {
  let source: string | undefined
  for (const file of fact.patches) {
    if (file.kind === 'update') source = file.path
    else if (file.kind === 'add') source = undefined
    else if (file.kind === 'delete' && outside(literal(file.path))) return true
    else if (file.kind === 'move' && source && outside(literal(source))) return true
  }
  return false
}

/** Whether a command deletes, or moves away, something outside the task folder. */
function deletesOutside({ fact, folders }: { fact: Fact; folders: string[] }) {
  const { argv } = fact
  const outside = (word: Word) => isOutside({ folders, fact, word })
  if (patchDeletesOutside(fact, outside)) return true
  if (!argv[0]) return false
  const name = argv[0].text
  const args = argv.slice(1)
  const paths = args.filter(({ text }) => !text.startsWith('-'))
  if (DELETERS.has(name)) {
    // `xargs rm` deletes paths read from its input, which cannot be seen here.
    return (fact.viaXargs && !fact.scan) || paths.some(outside)
  }
  if (name === 'mv') {
    // Moving something away removes it from its place; the last path is where it goes.
    return paths.slice(0, -1).some(outside) || (paths.at(-1)?.text.includes('.Trash') ?? false)
  }
  if (name === 'find' && args.some(({ text }) => text === '-delete' || text === '-exec' || text === '-execdir' || text === '-ok')) {
    // Options such as -L come before the paths, and the paths end at the first expression. No path means the current folder.
    const start = args.findIndex(({ text }) => !/^-([HLP]|O\d*|D)$/.test(text))
    const rest = start === -1 ? [] : args.slice(start)
    const expression = rest.findIndex(({ text }) => /^[-(!]/.test(text))
    const roots = expression === -1 ? rest : rest.slice(0, expression)
    return (roots.length === 0 ? [HERE] : roots).some(outside)
  }
  if (name === 'rsync' && args.some(({ text }) => text.startsWith('--delete') || text === '--remove-source-files')) {
    // The destination is the last path; a remote one (host:path) is outside too.
    const destination = paths.at(-1)
    return destination !== undefined && (/^[^/]*:/.test(destination.text) || outside(destination))
  }
  if (name === 'git' && args[0]?.text === 'clean') {
    return outside(fact.gitDir ?? HERE)
  }
  if (name === 'git' && args[0]?.text === 'worktree' && args[1]?.text === 'remove') {
    return args.slice(2).filter(({ text }) => !text.startsWith('-')).some(outside)
  }
  return false
}

/** Tools whose input names the one file they change. */
const FILE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }

/** A path and, when it exists in part, the same path with symlinks resolved. */
function pathForms(path: string) {
  return [...new Set([path, realPath(path)])]
}

/** macOS and Windows name files without regard to case by default, so `/USERS/me` is `/Users/me`. */
const foldCase = (path: string) => (process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path)

const within = (folder: string, path: string) => {
  const inside = relative(foldCase(folder), foldCase(path))
  return !inside.startsWith('..') && !isAbsolute(inside)
}

/** `~/x` and `$HOME/x` as the shell would expand them; anything else against `cwd`. */
function expandPath(path: string, cwd: string) {
  const home = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/
  return home.test(path) ? join(homedir(), path.replace(home, '')) : resolve(cwd, path)
}

/**
 * Whether a tool call touches the private folder outside the agent's own folder. File tools
 * and Codex patches are checked by the files they name. A shell command is refused when it
 * may reach the private folder at all, reading included: when any path it names, `..` too,
 * is in the folder, or it changes to a folder that cannot be followed. Reads go through the Read tool,
 * and BusyBoy's own state through its tools, so a shell command never needs to.
 */
function touchesPrivateFolder({ toolName, input, script, facts, folder, privateFolder }: {
  toolName: string
  input: unknown
  script: string | null
  facts: Fact[]
  folder: string
  privateFolder: string
}) {
  const own = pathForms(folder)
  const isPrivate = (path: string) =>
    pathForms(path).some((form) => pathForms(privateFolder).some((root) => within(root, form)) && !own.some((mine) => within(mine, form)))
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const named = FILE_TOOLS[toolName] ? fields[FILE_TOOLS[toolName]] : undefined
  if (typeof named === 'string') {
    return isPrivate(expandPath(named, folder))
  }
  // Codex's patch tool. The hook reports it with the patch, sometimes JSON-wrapped, in the input.
  if (isPatchTool(toolName) && patchAnalysis(input, folder).facts.some((fact) => fact.patches.some((file) => isPrivate(expandPath(file.path, folder))))) {
    return true
  }
  if (script === null) {
    return false
  }
  if (facts.some((fact) => fact.cwd === null || isPrivate(fact.cwd))) {
    return true
  }
  if (facts.some((fact) => fact.patches.some((file) => isPrivate(expandPath(file.path, fact.cwd ?? folder))))) {
    return true
  }
  // Every word of the command line that could be a path, redirection targets included, read
  // with its quotes taken off (`~/".busyboy"`, `"$HOME"/x`) and resolved from each folder the
  // command line runs in. Matching words, not the text, keeps `~/.busyboy-backup` apart.
  const folders = [folder, ...facts.map((fact) => fact.cwd ?? folder)]
  const words = script
    .replace(/["']/g, '')
    .split(/[\s;&|()<>`]+/)
    .map((word) => word.replace(/^[^=/~$.]*=/, ''))
    .filter((word) => /^(?:~|\$HOME\b|\$\{HOME\}|\.)|\//.test(word))
  return words.some((word) => folders.some((cwd) => isPrivate(expandPath(word, cwd))))
}

const TOOL_NAME = /^[A-Za-z0-9_*][A-Za-z0-9_*.:-]*$/

/** Why a rule can never match, or null when it is a rule the matcher reads. */
export function ruleError(rule: string) {
  const text = rule.trim()
  if (!text || text.startsWith('#') || BUILT_IN_RULES.some((builtIn) => builtIn.toLowerCase() === text.toLowerCase())) {
    return null
  }
  if (text.includes('(') && !/^[^\s()]+\(.*\)$/.test(text)) {
    return `"${text}" needs the form Tool(pattern), with the closing parenthesis.`
  }
  // Tool names are words such as Bash or mcp__server__tool; a path or a command is not one.
  if (!TOOL_NAME.test(text.replace(/\(.*$/s, ''))) {
    return `"${text}" is not a tool name. Write a command as Bash(${text}).`
  }
  return null
}

const isBuiltIn = (rule: string, builtIn: string) => rule.toLowerCase() === builtIn.toLowerCase()

/** Whether a rule applies to shell commands, so a command that cannot be read asks under the list. */
const isShellRule = (rule: string) =>
  rule === 'Bash' ||
  rule.startsWith('Bash(') ||
  [FORCE_PUSH_RULE, DEFAULT_BRANCH_RULE, DEPLOY_RULE, DELETE_OUTSIDE_RULE].some((builtIn) => isBuiltIn(rule, builtIn))

/**
 * The first rule this tool call matches; `UNREADABLE: <why>` when it is a shell
 * command that cannot be read in full and the list has a shell rule; or null.
 * `folder` is the agent's working folder.
 */
export function matchAlwaysAsk({
  rules,
  toolName,
  input,
  folder,
  privateFolder,
  noFileEdits,
}: {
  rules: string[]
  toolName: string
  input: unknown
  folder: string
  /** A folder the agent may not change outside `folder` (see BUSYBOY_FILES_RULE). */
  privateFolder?: string
  /** The agent asks before anything that could change its folder (see SUBAGENT_EDIT_RULE). */
  noFileEdits?: boolean
}) {
  const valid = rules.map((rule) => rule.trim()).filter((rule) => rule && !rule.startsWith('#') && !ruleError(rule))
  const script = shellCommand(toolName, input)
  run = { steps: 0, files: new Map(), git: new Map() }
  // A shell tool whose input has no command BusyBoy can read is treated as unreadable, not as a
  // tool call that runs nothing: matching fails closed.
  const unreadableShell: Analysis = { facts: [], unknown: 'the shell tool call has no command BusyBoy can read' }
  const { facts, unknown } = merge([
    script !== null ? analyze(script, { cwd: folder, depth: 0, scan: false }) : isShellTool(toolName) ? unreadableShell : NOTHING,
    // A patch sent as its own tool, including one wrapped in JSON, names files rather than a command.
    isPatchTool(toolName) ? patchAnalysis(input, folder) : NOTHING,
  ])
  // The folder as given and with symlinks resolved (/var and /private/var on macOS).
  const folders = [folder]
  try {
    folders.push(realpathSync(folder))
  } catch {
    // A folder that does not exist yet is compared as given.
  }

  if (noFileEdits && subagentChanges({ toolName, script, facts, unknown })) {
    return SUBAGENT_EDIT_RULE
  }
  if (privateFolder && touchesPrivateFolder({ toolName, input, script, facts, folder, privateFolder })) {
    return BUSYBOY_FILES_RULE
  }
  for (const rule of valid) {
    let matched: boolean
    if (isBuiltIn(rule, FORCE_PUSH_RULE)) {
      matched = facts.some(isForcePush)
    } else if (isBuiltIn(rule, DEFAULT_BRANCH_RULE)) {
      matched = facts.some(pushesDefaultBranch)
    } else if (isBuiltIn(rule, DEPLOY_RULE)) {
      matched = facts.some(deploys)
    } else if (isBuiltIn(rule, DELETE_OUTSIDE_RULE)) {
      matched = facts.some((fact) => deletesOutside({ fact, folders }))
    } else if (isBuiltIn(rule, CONNECTOR_RULE)) {
      matched = isConnectorWrite(toolName)
    } else {
      const [, tool, pattern] = /^([^()]+?)(?:\((.*)\))?$/.exec(rule) ?? []
      // Shell rules are written for Bash; they apply to every provider's shell tool.
      const toolMatches = tool === 'Bash' ? script !== null : globMatches({ glob: tool, text: toolName })
      const subjects = script === null ? [JSON.stringify(input ?? {})] : facts.flatMap(({ written, argv }) => [joined(written), joined(argv)])
      matched = toolMatches && (pattern === undefined || subjects.some((text) => globMatches({ glob: pattern, text })))
    }
    if (matched) {
      return rule
    }
  }
  // A private folder makes every unreadable command ask: it may reach the folder.
  if (unknown && (privateFolder || valid.some(isShellRule))) {
    return `${UNREADABLE}: ${unknown}`
  }
  return null
}

/**
 * Where a call runs: the folder with symlinks resolved and, in a repository, the checked-out
 * ref and commit. Null when git cannot say, so nothing is remembered on a guess. One git call,
 * made only for a call that matched a rule.
 */
function placeOf(cwd: string) {
  let folder = cwd
  try {
    folder = realpathSync(cwd)
  } catch {
    // A folder that does not exist yet is named as given.
  }
  if (!existsSync(join(folder, '.git')) && !isInsideRepository(folder)) return `${folder}@none`
  try {
    const out = execFileSync('git', ['-C', folder, 'rev-parse', '--symbolic-full-name', 'HEAD', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return `${folder}@${out.trim().replace(/\s+/g, ' ')}`
  } catch {
    return null
  }
}

/** Whether a folder below the file system root holds a `.git`, without running git. */
function isInsideRepository(folder: string) {
  for (let current = dirname(folder); current !== dirname(current); current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return true
  }
  return false
}

/**
 * The always-ask calls the user allowed again for one agent. A call is remembered with the
 * rule it matched, the folder it ran in, and that folder's branch, because the same text can
 * do something else later: `git push --force origin HEAD` after `git checkout main` pushes
 * main. Any difference asks again. Remembering the rule alone would let the agent run anything
 * it matches. A Bash call's description and timeout change between calls and are left out.
 * A command that moves to another folder (`cd`, `git -C`) is never remembered: the branch
 * there is only known when it runs.
 */
export function createAllowedCalls() {
  const allowed = new Set<string>()
  const key = ({ toolName, input, rule, cwd }: AllowedCall) => {
    const script = shellCommand(toolName, input)
    if (script !== null) {
      run = { steps: 0, files: new Map(), git: new Map() }
      const { facts, unknown } = analyze(script, { cwd, depth: 0, scan: false })
      if (unknown || facts.some((fact) => fact.cwd !== cwd || fact.gitDir !== null)) return null
    }
    const place = placeOf(cwd)
    if (place === null) return null
    const { description: _description, timeout: _timeout, ...rest } = input && typeof input === 'object' ? (input as Record<string, unknown>) : { value: input }
    return JSON.stringify([rule, toolName, rest, place])
  }
  return {
    has: (call: AllowedCall) => {
      const found = key(call)
      return found !== null && allowed.has(found)
    },
    add: (call: AllowedCall) => {
      const found = key(call)
      if (found !== null) allowed.add(found)
    },
  }
}

type AllowedCall = { toolName: string; input: unknown; rule: string; cwd: string }

/**
 * The approval an adapter emits for a matched tool call. Its allow-for-session option
 * remembers only this exact call (see createAllowedCalls).
 */
export function alwaysAskApproval({ requestId, toolName, input, rule }: { requestId: string; toolName: string; input: unknown; rule: string }) {
  const script = shellCommand(toolName, input)
  const reason = rule.startsWith(UNREADABLE) || rule === BUSYBOY_FILES_RULE || rule === SUBAGENT_EDIT_RULE ? `${rule}.` : `On your always-ask list: ${rule}`
  const event: Extract<AgentEvent, { type: 'approval' }> = {
    type: 'approval',
    requestId,
    title: script === null ? toolName : `${toolName}: ${script}`,
    detail: `${reason}${script === null ? `\n${JSON.stringify(input ?? {}, null, 2)}` : ''}`,
    // BusyBoy's own files are never the user's to open up, so that rule asks every time.
    canAllowForSession: rule !== BUSYBOY_FILES_RULE && rule !== SUBAGENT_EDIT_RULE,
    allowForSessionLabel: `Always allow this exact ${script === null ? 'call' : 'command'}`,
  }
  return event
}
