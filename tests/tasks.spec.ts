import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// A request the task-agents script answers (tests/provider-scripts/task-agents.json).
const REQUEST = 'Add a CONTRIBUTING.md that explains how to run the project.'

type StoredTask = { id: string; project: string; title: string; worktree: string; branch: string; sessionId: string | null }

function storedTasks(home: string): StoredTask[] {
  const file = join(home, 'task-list.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { tasks: StoredTask[] }).tasks : []
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

/** Calls a busyboy MCP tool the way an agent does, with this context's data folder cookie. */
async function callTool(request: APIRequestContext, name: string, args: Record<string, string>) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  })
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  return { isError: Boolean(body.result.isError), text: body.result.content[0].text }
}

test('calling create_task should create a worktree and start a task agent', async ({ context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web', 'api'])

  const result = await callTool(context.request, 'create_task', { project: 'web', title: 'Add CONTRIBUTING.md', request: REQUEST })

  expect(result.isError).toBe(false)
  const [task] = storedTasks(home)
  expect(result.text).toContain(`Created task ${task.id} in web`)
  expect(task).toMatchObject({ project: 'web', title: 'Add CONTRIBUTING.md', branch: `busyboy/${task.id}` })
  expect(task.worktree).toBe(join(home, 'task-worktrees', 'web', task.id))
  expect(git(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(task.branch)
  expect(git(task.worktree, 'rev-parse', 'HEAD')).toBe(git(projects.web, 'rev-parse', 'HEAD'))
  // The task agent started and its session id was saved for resume.
  await expect.poll(() => storedTasks(home)[0]?.sessionId).toMatch(/^scripted-/)
})

test('calling create_task for an unknown project should list the projects', async ({ context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ['web', 'api'])

  const result = await callTool(context.request, 'create_task', { project: 'mobile', title: 'Fix login', request: REQUEST })

  expect(result).toEqual({ isError: true, text: 'There is no project named "mobile". Projects: web, api.' })
  expect(storedTasks(home)).toEqual([])
})

test('a git hook run while creating a task should not see busyboy variables', async ({ context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['web'])
  const envFile = join(home, 'hook-env.txt')
  const hook = join(projects.web, '.git', 'hooks', 'post-checkout')
  writeFileSync(hook, `#!/bin/sh\nenv > '${envFile}'\n`)
  chmodSync(hook, 0o755)

  await callTool(context.request, 'create_task', { project: 'web', title: 'Add CONTRIBUTING.md', request: REQUEST })

  const names = readFileSync(envFile, 'utf8')
    .split('\n')
    .map((line) => line.split('=')[0])
  expect(names).toContain('PATH')
  expect(names.filter((name) => /^(BUSYBOY_|PORT$|HOSTNAME$|NODE_ENV$|NEXT_RUNTIME$|__NEXT)/.test(name))).toEqual([])
})
