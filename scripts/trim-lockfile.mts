export function lockfileForImporter(
  lockText: string,
  importer: string,
  keep: ReadonlySet<string>,
): string {
  const newline = lockText.endsWith("\r\n") ? "\r\n" : "\n";
  const lines = lockText.split(/\r?\n/);
  const importersAt = lines.indexOf("importers:");
  if (importersAt === -1) throw new Error("pnpm-lock.yaml has no importers section.");
  const packagesAt = lines.indexOf("packages:");
  if (packagesAt === -1) throw new Error("pnpm-lock.yaml has no packages section.");
  const header = `  ${importer}:`;
  const start = lines.indexOf(header);
  if (start === -1 || start > packagesAt)
    throw new Error(`pnpm-lock.yaml has no ${importer} importer.`);

  const kept: string[] = [];
  let index = start + 1;
  while (index < packagesAt) {
    const line = lines[index]!;
    if (line.startsWith("  ") && !line.startsWith("   ") && line.endsWith(":")) break;
    if (line !== "    dependencies:" && line !== "    optionalDependencies:") {
      index++;
      continue;
    }
    index++;
    while (index < packagesAt && lines[index]!.startsWith("      ")) {
      const nameLine = lines[index]!;
      if (!nameLine.startsWith("      ") || nameLine.startsWith("        ")) {
        throw new Error(`Unexpected line in pnpm-lock.yaml importers: ${nameLine}`);
      }
      const block = [nameLine];
      index++;
      while (index < packagesAt && lines[index]!.startsWith("        "))
        block.push(lines[index++]!);
      const name = unquote(nameLine.trim().replace(/:$/, ""));
      if (keep.has(name)) kept.push(...block);
    }
  }

  const staged = [...lines.slice(0, importersAt + 1), "", "  .:", ""];
  if (kept.length > 0) {
    staged.push("    dependencies:");
    staged.push(...kept);
  }
  staged.push(...lines.slice(packagesAt));
  return staged.join(newline);
}

function unquote(value: string) {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replaceAll("''", "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}
