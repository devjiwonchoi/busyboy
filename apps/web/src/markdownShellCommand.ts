const RUNNABLE_SHELL_LANGUAGES = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "shell",
  "shellscript",
  "console",
  "shell-session",
  "shellsession",
  "sh-session",
  "terminal",
  "powershell",
  "pwsh",
]);

const PROMPT_LINE = /^\s*\$ /;

/**
 * The command a chat code block's Run button sends to the terminal, or null when
 * the block should not get a Run button.
 *
 * When any line starts with a "$ " prompt (a console transcript), only those
 * lines run, without the prompt; the other lines are output.
 */
export function runnableShellCommand(code: string, language: string): string | null {
  if (!RUNNABLE_SHELL_LANGUAGES.has(language.toLowerCase())) return null;
  // Control and invisible format characters (tabs, bidi overrides, zero-width)
  // can make the rendered command differ from what the terminal would receive.
  if (/[\p{Cc}\p{Cf}]/u.test(code.replaceAll("\n", ""))) return null;

  const lines = code.split("\n");
  const promptLines = lines.filter((line) => PROMPT_LINE.test(line));
  const command = (
    promptLines.length > 0 ? promptLines.map((line) => line.replace(PROMPT_LINE, "")) : lines
  )
    .join("\n")
    .trim();
  // A trailing backslash would leave the shell waiting for more input.
  if (command.length === 0 || command.endsWith("\\")) return null;
  return command;
}
