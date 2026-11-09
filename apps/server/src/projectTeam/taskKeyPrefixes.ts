import { defaultTaskKeyPrefix } from "@t3tools/contracts";

type PrefixProject = {
  readonly projectId: string;
  readonly title: string;
  readonly prefix: string | undefined;
  readonly aliases: ReadonlyArray<string>;
};

/** Keep saved keys stable, then resolve legacy collisions in a deterministic order. */
export function allocateTaskKeyPrefixes({ projects }: { projects: ReadonlyArray<PrefixProject> }) {
  const ordered = [...projects].sort(
    (left, right) =>
      left.title.localeCompare(right.title, "en") || left.projectId.localeCompare(right.projectId),
  );
  const prefixes = new Map<string, string>();
  const used = new Set<string>();

  // Reserve every saved prefix before allocating suffixes, including another project's NB2.
  for (const project of ordered) {
    if (project.prefix !== undefined && !used.has(project.prefix)) {
      prefixes.set(project.projectId, project.prefix);
      used.add(project.prefix);
    }
  }
  return ordered.map((project) => {
    const previous = project.prefix ?? defaultTaskKeyPrefix(project.title);
    let prefix = prefixes.get(project.projectId);
    if (prefix === undefined) {
      prefix = previous;
      for (let suffix = 2; used.has(prefix); suffix += 1) {
        const tail = String(suffix);
        if (tail.length > 5) {
          throw new Error("사용할 수 있는 태스크 접두어가 없습니다. 다른 접두어를 지정해 주세요.");
        }
        prefix = `${previous.slice(0, 6 - tail.length)}${tail}`;
      }
      used.add(prefix);
    }
    return {
      projectId: project.projectId,
      prefix,
      aliases: [...new Set([...project.aliases, ...(prefix === previous ? [] : [previous])])],
    };
  });
}
