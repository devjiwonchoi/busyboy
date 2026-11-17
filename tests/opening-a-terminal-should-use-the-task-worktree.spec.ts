import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { addRecordTask } from './support/record-tasks'

const HEALTH = { id: 'add-health-endpoint-d4e5f6', title: 'Add a health endpoint' }

test('opening a terminal should use the task worktree when its project name differs in case', async ({ context, baseURL }) => {
  const { home, projects } = await useProjectsHome(context, baseURL!, ['api'])
  const health = await addRecordTask(home, { project: 'api', projectPath: projects.api, ...HEALTH })
  const file = join(home, 'task-list.json')
  const list = JSON.parse(readFileSync(file, 'utf8')) as { tasks: { project: string }[] }
  // The folder on disk is `api`. A case-insensitive disk still means that folder.
  list.tasks[0].project = 'Api'
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`)

  const response = await context.request.post('/api/terminal', {
    data: { taskId: HEALTH.id, cols: 80, rows: 24 },
  })
  if (process.platform === 'linux') {
    expect(response.status()).toBe(400)
    expect((await response.json()).error).toContain('not one of BusyBoy')
    return
  }
  expect(response.status()).toBe(201)
  expect((await response.json()).cwd).toBe(realpathSync(health.worktree))
})
