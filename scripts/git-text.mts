import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function gitText(args: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'busyboy-git-'));
  const output = join(directory, 'out');
  const fd = openSync(output, 'w');
  const result = spawnSync('git', args, { stdio: ['ignore', fd, 'pipe'] });
  closeSync(fd);
  const stderr = result.stderr?.toString() ?? '';
  if (result.error || result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    console.error(stderr.trim() || result.error?.message || `git exited ${result.status}`);
    process.exit(1);
  }
  const text = readFileSync(output, 'utf8');
  rmSync(directory, { recursive: true, force: true });
  return text;
}
