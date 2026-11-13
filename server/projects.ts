import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readSettings, updateSettings, type ProjectEntry } from './config'

// A project is a name plus one folder that is a git repository. Projects live
// in the settings file; removing one only forgets it and never touches files.

export type Project = ProjectEntry

export class ProjectError extends Error {}

const run = promisify(execFile)
const MAX_NAME_LENGTH = 64

export async function listProjects(): Promise<Project[]> {
  return (await readSettings()).projects
}

export async function getProject(name: string): Promise<Project | undefined> {
  return (await listProjects()).find((project) => project.name === name)
}

// Names are used as folder names by later features, so they must be valid
// file names on macOS and Windows. `@` starts a project mention in the chat.
const INVALID_CHARACTERS = /[/\\:<>"|?*\u0000-\u001f]/g
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Checks the name and returns it trimmed. */
function checkName(name: string) {
  const trimmed = name.trim()
  if (!trimmed) throw new ProjectError('Enter a project name.')
  if (trimmed.length > MAX_NAME_LENGTH) throw new ProjectError(`Use at most ${MAX_NAME_LENGTH} characters.`)
  if (new RegExp(INVALID_CHARACTERS.source).test(trimmed)) {
    throw new ProjectError('A project name cannot contain / \\ : < > " | ? * or control characters.')
  }
  if (trimmed.startsWith('@')) throw new ProjectError('A project name cannot start with @.')
  if (/^\.+$/.test(trimmed) || trimmed.endsWith('.')) throw new ProjectError('A project name cannot end with a dot.')
  if (RESERVED_NAMES.test(trimmed)) throw new ProjectError(`${trimmed} is reserved on Windows. Choose another name.`)
  return trimmed
}

/** A valid name made from a folder name, for example `@scope` becomes `scope`. */
function nameFromFolder(folder: string) {
  let name = folder.replace(INVALID_CHARACTERS, '-').replace(/^[@\s]+/, '')
  name = name.slice(0, MAX_NAME_LENGTH).replace(/[.\s]+$/, '').trim()
  if (!name) name = 'project'
  if (RESERVED_NAMES.test(name)) name = `${name.split('.')[0]}-project`
  return name
}

function sameName(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase()
}

function expandHome(path: string) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Returns the real path of the repository's top-level folder, or throws a message for the user. */
async function checkRepository(input: string) {
  const typed = input.trim()
  if (!typed) throw new ProjectError('Enter the path of a folder.')
  const expanded = expandHome(typed)
  if (!isAbsolute(expanded)) throw new ProjectError('Enter a full path, for example ~/code/my-app.')
  const folder = resolve(expanded)
  const info = await stat(folder).catch(() => null)
  if (!info) throw new ProjectError(`${folder} does not exist.`)
  if (!info.isDirectory()) throw new ProjectError(`${folder} is not a folder.`)
  const real = await realpath(folder)
  let topLevel: string
  try {
    const { stdout } = await run('git', ['-C', real, 'rev-parse', '--show-toplevel'])
    topLevel = await realpath(stdout.trim())
  } catch {
    throw new ProjectError(`${folder} is not a git repository. Run git init there, or choose another folder.`)
  }
  if (topLevel !== real) {
    throw new ProjectError(`${folder} is inside the git repository at ${topLevel}. Add that folder instead.`)
  }
  return real
}

/** Names are unique ignoring case, since folders on macOS and Windows usually are. */
function uniqueName(base: string, projects: Project[]) {
  const taken = new Set(projects.map((project) => project.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** Adds a git repository. The name defaults to the folder name and is made unique. */
export async function addProject(folder: string, name?: string): Promise<Project> {
  const path = await checkRepository(folder)
  const requested = name?.trim() ? checkName(name) : undefined
  return updateSettings((settings) => {
    const existing = settings.projects.find((project) => project.path === path)
    if (existing) throw new ProjectError(`This folder is already added as ${existing.name}.`)
    if (requested && settings.projects.some((project) => sameName(project.name, requested))) {
      throw new ProjectError(`A project named ${requested} already exists.`)
    }
    const project: Project = {
      name: requested ?? uniqueName(nameFromFolder(basename(path)), settings.projects),
      path,
      addedAt: new Date().toISOString(),
    }
    settings.projects.push(project)
    return project
  })
}

export async function renameProject(name: string, newName: string): Promise<Project> {
  const next = checkName(newName)
  return updateSettings((settings) => {
    const project = settings.projects.find((entry) => entry.name === name)
    if (!project) throw new ProjectError(`There is no project named ${name}.`)
    if (settings.projects.some((entry) => entry !== project && sameName(entry.name, next))) {
      throw new ProjectError(`A project named ${next} already exists.`)
    }
    project.name = next
    return { ...project }
  })
}

/** Forgets the project. Its folder and files stay as they are. */
export async function removeProject(name: string): Promise<void> {
  await updateSettings((settings) => {
    settings.projects = settings.projects.filter((project) => project.name !== name)
  })
}
