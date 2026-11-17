'use server'

import { listProjectFiles } from '@/server/project-files'
import { defaultProvider } from '@/server/providers'
import { listSkills, skillInvocation, type ComposerSkill } from '@/server/skills'

const MAX_NAME_LENGTH = 64

/** Skills for the `/` picker, invoked the way the provider that will answer expects. */
export async function composerSkillsAction(project?: string): Promise<ComposerSkill[]> {
  if (project !== undefined && (typeof project !== 'string' || project.length > MAX_NAME_LENGTH)) {
    throw new Error('The project must be a name.')
  }
  const provider = await defaultProvider()
  const skills = await listSkills(project)
  return skills.map((skill) => ({ ...skill, invocation: skillInvocation(provider, skill.name) }))
}

/** Tracked files for the `@` picker in a task or manager chat. */
export async function projectFilesAction(project: string): Promise<{ path: string }[]> {
  if (typeof project !== 'string' || !project.trim() || project.length > MAX_NAME_LENGTH) {
    throw new Error('The project must be a name.')
  }
  return listProjectFiles(project.trim())
}
