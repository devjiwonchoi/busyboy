import { appendFile, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

export const TRANSCRIPT_FILE = "transcript.jsonl";

// Each file stays near 20MB. One entry larger than the limit is written whole.
export const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;

const SEGMENT_NAME = /^transcript\.(\d+)\.jsonl$/;

export type TranscriptCursor = { bytes?: number };

async function fileSize(file: string) {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export async function readTranscript(folder: string) {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  const segments = names
    .flatMap((name) => {
      const match = SEGMENT_NAME.exec(name);
      return match ? [{ name, index: Number(match[1]) }] : [];
    })
    .sort((left, right) => left.index - right.index);
  let text = "";
  for (const segment of segments) {
    text = appendPart(text, await readFile(join(folder, segment.name), "utf8").catch(() => ""));
  }
  return appendPart(text, await readFile(join(folder, TRANSCRIPT_FILE), "utf8").catch(() => ""));
}

function appendPart(text: string, part: string) {
  if (!part) return text;
  if (text && !text.endsWith("\n")) return `${text}\n${part}`;
  return text + part;
}

async function nextSegment(folder: string) {
  const names = await readdir(folder);
  const highest = names.reduce((max, name) => {
    const match = SEGMENT_NAME.exec(name);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return highest + 1;
}

export async function appendTranscriptLine(folder: string, line: string, cursor: TranscriptCursor) {
  await mkdir(folder, { recursive: true });
  const file = join(folder, TRANSCRIPT_FILE);
  if (cursor.bytes === undefined) cursor.bytes = await fileSize(file);
  const added = Buffer.byteLength(line);
  if (cursor.bytes > 0 && cursor.bytes + added > MAX_TRANSCRIPT_BYTES) {
    const archived = join(folder, `transcript.${await nextSegment(folder)}.jsonl`);
    try {
      await rename(file, archived);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    cursor.bytes = 0;
  }
  await appendFile(file, line);
  cursor.bytes += added;
}
