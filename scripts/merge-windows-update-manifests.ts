#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain release script run by the publish job.
// Each Windows build writes its own latest.yml. electron-updater reads one latest.yml per
// release and picks the file whose name contains the running arch, so the publish job merges
// the x64 and arm64 manifests into one. A trimmed port of t3code's merge-update-manifests.
//
//   node scripts/merge-windows-update-manifests.ts <out> <latest-x64.yml> <latest-arm64.yml>
import * as NodeFS from "node:fs";

export interface UpdateManifestFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number;
}

export interface UpdateManifest {
  readonly version: string;
  readonly releaseDate: string;
  readonly files: ReadonlyArray<UpdateManifestFile>;
}

const unquote = (value: string) => {
  const trimmed = value.trim();
  return trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2
    ? trimmed.slice(1, -1).replace(/''/g, "'")
    : trimmed;
};

/** Reads the subset of electron-builder's latest.yml that electron-updater needs. */
export function parseUpdateManifest(raw: string, source: string): UpdateManifest {
  let version: string | undefined;
  let releaseDate: string | undefined;
  const files: Array<Partial<{ url: string; sha512: string; size: number }>> = [];
  for (const line of raw.split(/\r?\n/)) {
    const url = /^ {2}- url:\s*(.+)$/.exec(line);
    if (url?.[1]) {
      files.push({ url: unquote(url[1]) });
      continue;
    }
    const field = /^ {4}(sha512|size):\s*(.+)$/.exec(line);
    if (field?.[1] && field[2]) {
      const file = files.at(-1);
      if (!file) throw new Error(`${source}: ${field[1]} outside a file entry.`);
      if (field[1] === "size") file.size = Number(field[2]);
      else file.sha512 = unquote(field[2]);
      continue;
    }
    const top = /^(version|releaseDate):\s*(.+)$/.exec(line);
    if (top?.[1] === "version") version = unquote(top[2]!);
    if (top?.[1] === "releaseDate") releaseDate = unquote(top[2]!);
  }
  if (!version) throw new Error(`${source}: missing version.`);
  if (!releaseDate) throw new Error(`${source}: missing releaseDate.`);
  if (files.length === 0) throw new Error(`${source}: missing files.`);
  return {
    version,
    releaseDate,
    files: files.map((file) => {
      if (!file.url || !file.sha512 || !Number.isFinite(file.size)) {
        throw new Error(`${source}: incomplete file entry ${file.url ?? ""}.`);
      }
      return { url: file.url, sha512: file.sha512, size: file.size! };
    }),
  };
}

export function mergeUpdateManifests(manifests: ReadonlyArray<UpdateManifest>): UpdateManifest {
  const first = manifests[0];
  if (!first) throw new Error("No update manifests to merge.");
  const files = new Map<string, UpdateManifestFile>();
  let releaseDate = first.releaseDate;
  for (const manifest of manifests) {
    if (manifest.version !== first.version) {
      throw new Error(`Cannot merge versions ${first.version} and ${manifest.version}.`);
    }
    if (manifest.releaseDate > releaseDate) releaseDate = manifest.releaseDate;
    for (const file of manifest.files) {
      const existing = files.get(file.url);
      if (existing && (existing.sha512 !== file.sha512 || existing.size !== file.size)) {
        throw new Error(`Conflicting entries for ${file.url}.`);
      }
      files.set(file.url, file);
    }
  }
  return { version: first.version, releaseDate, files: [...files.values()] };
}

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

// No top-level path/sha512: they could only name one arch, and electron-updater reads `files`.
export function serializeUpdateManifest(manifest: UpdateManifest): string {
  return [
    `version: ${quote(manifest.version)}`,
    "files:",
    ...manifest.files.flatMap((file) => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    ]),
    `releaseDate: ${quote(manifest.releaseDate)}`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const [output, ...inputs] = process.argv.slice(2);
  if (!output || inputs.length === 0) {
    console.error("usage: merge-windows-update-manifests.ts <out> <latest.yml>...");
    process.exit(1);
  }
  const merged = mergeUpdateManifests(
    inputs.map((input) => parseUpdateManifest(NodeFS.readFileSync(input, "utf8"), input)),
  );
  NodeFS.writeFileSync(output, serializeUpdateManifest(merged));
  console.log(serializeUpdateManifest(merged));
}
