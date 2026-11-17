import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { containsPath, samePath } from "../paths";
import { locateTaskRecords } from "../records/record-location";

// The markdown view only draws http(s) or root-relative images, so a worktree path would be dropped.

const FENCE = /^\s*(```|~~~)/;
const LINK = /(!?\[[^\]\n]*\])\((<[^>\n]+>|[^)\s]+)(?:\s+("[^"\n]*"|'[^'\n]*'))?\)/g;
const DEFINITION = /^(\[[^\]\n]+\]:\s+)(\S+)/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_PATH = /^[a-z]:[\\/]/i;
const CODE_SPAN = /`[^`\n]*`/g;

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const IMAGE_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

type ArtifactContext = { taskId: string; recordFolder: string; worktree: string };

export type TaskArtifact = {
  bytes: Buffer;
  contentType: string;
  inline: boolean;
  name: string;
};

export function artifactUrl(taskId: string, relativeFile: string) {
  return `/api/task-artifact?${new URLSearchParams({ task: taskId, file: relativeFile }).toString()}`;
}

function safeRelative(file: string) {
  if (!file || file.length > 1000 || file.includes("\0")) return null;
  const slash = file.replaceAll("\\", "/");
  if (slash.startsWith("/") || WINDOWS_PATH.test(slash)) return null;
  const parts: string[] = [];
  for (const part of slash.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function extensionOf(file: string) {
  const dot = file.lastIndexOf(".");
  return dot === -1 ? "" : file.slice(dot).toLowerCase();
}

function hostedArtifact(destination: string, context: ArtifactContext) {
  const raw = destination.trim();
  if (!raw || raw.startsWith("#") || raw.includes("\0")) return null;
  let pathText = raw;
  if (/^file:/i.test(raw)) {
    try {
      pathText = fileURLToPath(raw);
    } catch {
      return null;
    }
  } else if (!WINDOWS_PATH.test(raw) && SCHEME.test(raw)) {
    return null;
  }
  let decoded = pathText;
  try {
    decoded = decodeURI(pathText);
  } catch {
    return null;
  }
  const cutAt = ["?", "#"].map((mark) => decoded.indexOf(mark)).filter((index) => index >= 0);
  const pathOnly = cutAt.length > 0 ? decoded.slice(0, Math.min(...cutAt)) : decoded;
  if (!pathOnly || pathOnly.includes("\0")) return null;
  const absolute = isAbsolute(pathOnly)
    ? pathOnly
    : resolve(/*turbopackIgnore: true*/ context.recordFolder, pathOnly);
  const root =
    containsPath(context.recordFolder, absolute) && !samePath(context.recordFolder, absolute)
      ? context.recordFolder
      : containsPath(context.worktree, absolute) && !samePath(context.worktree, absolute)
        ? context.worktree
        : null;
  if (!root) return null;
  const relativeFile = relative(/*turbopackIgnore: true*/ root, absolute).split(sep).join("/");
  if (!safeRelative(relativeFile)) return null;
  return artifactUrl(context.taskId, relativeFile);
}

function rewritePlain(text: string, context: ArtifactContext) {
  LINK.lastIndex = 0;
  const linked = text.replace(LINK, (full, label: string, dest: string, title?: string) => {
    const inner = dest.startsWith("<") && dest.endsWith(">") ? dest.slice(1, -1).trim() : dest;
    const next = hostedArtifact(inner, context);
    if (!next) return full;
    return `${label}(${next}${title ? ` ${title}` : ""})`;
  });
  return linked.replace(DEFINITION, (full, prefix: string, dest: string) => {
    const next = hostedArtifact(dest, context);
    return next ? `${prefix}${next}` : full;
  });
}

export function linkTaskArtifacts(markdown: string, context: ArtifactContext) {
  let fenced = false;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const parts: string[] = [];
      let last = 0;
      CODE_SPAN.lastIndex = 0;
      for (const match of line.matchAll(CODE_SPAN)) {
        const index = match.index ?? 0;
        parts.push(rewritePlain(line.slice(last, index), context));
        parts.push(match[0]);
        last = index + match[0].length;
      }
      parts.push(rewritePlain(line.slice(last), context));
      return parts.join("");
    })
    .join("\n");
}

// A symbolic link is refused: the cited file has to stay inside the record folder or the worktree.
export async function readTaskArtifact({
  folder,
  taskId,
  file,
}: {
  folder: string;
  taskId: string;
  file: string;
}): Promise<TaskArtifact | "too-large" | null> {
  const relativeFile = safeRelative(file);
  if (!relativeFile || taskId.length > 500) return null;
  const { readTasksAt } = await import("../tasks");
  const task = (await readTasksAt(folder)).find((item) => item.id === taskId);
  if (!task) return null;
  const located = await locateTaskRecords(folder, task);
  const roots = [located && "folder" in located ? located.folder : null, task.worktree].filter(
    (root): root is string => root !== null,
  );
  for (const root of roots) {
    const found = await readArtifactFile(root, relativeFile);
    if (found) return found;
  }
  return null;
}

async function readArtifactFile(
  root: string,
  relativeFile: string,
): Promise<TaskArtifact | "too-large" | null> {
  const absolute = join(/*turbopackIgnore: true*/ root, ...relativeFile.split("/"));
  if (!containsPath(root, absolute)) return null;
  const parts = relativeFile.split("/");
  let current = root;
  let stats;
  try {
    if ((await lstat(/*turbopackIgnore: true*/ current)).isSymbolicLink()) return null;
    for (const [index, part] of parts.entries()) {
      current = join(/*turbopackIgnore: true*/ current, part);
      stats = await lstat(/*turbopackIgnore: true*/ current);
      if (stats.isSymbolicLink()) return null;
      const last = index === parts.length - 1;
      if (last ? !stats.isFile() : !stats.isDirectory()) return null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats) return null;
  if (stats.size > MAX_ARTIFACT_BYTES) return "too-large";
  const name = parts[parts.length - 1];
  const contentType = IMAGE_TYPE[extensionOf(name)] ?? "application/octet-stream";
  return {
    bytes: await readFile(/*turbopackIgnore: true*/ absolute),
    contentType,
    inline: contentType.startsWith("image/"),
    name,
  };
}
