'use client'

import { ArrowUp, Square } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { composerSkillsAction, projectFilesAction } from '@/app/(main)/composer-actions'
import { Button } from '@/components/ui/button'
import {
  Composer,
  ComposerActionGroup,
  ComposerActions,
  ComposerInput,
  ComposerItem,
  type ComposerItemValue,
  ComposerList,
  ComposerPopup,
  ComposerSubmit,
  type ComposerValue,
  getComposerText,
} from '@/components/ui/composer'
import type { ComposerSkill } from '@/server/skills'

/**
 * The message box. Enter sends, Shift+Enter adds a line.
 * `@` opens a picker and `/` opens skills and commands. Arrow keys move,
 * Enter chooses, Escape or Tab closes the picker.
 */
export function ChatComposer({
  projects,
  filesProject,
  showCommands = true,
  canStop = false,
  canArchive = false,
  onCommand,
  placeholder,
  onSend,
  onStop,
  label = 'Message',
  sendLabel = 'Send',
  leading,
}: {
  /** Project names for the Director's `@` picker. Ignored while `filesProject` is set. */
  projects: string[]
  /** When set, `@` lists this project's tracked files instead of projects. */
  filesProject?: string | null
  /** BusyBoy commands in the `/` picker. A side question leaves them out. */
  showCommands?: boolean
  canStop?: boolean
  canArchive?: boolean
  onCommand?: (command: 'stop' | 'archive') => void
  placeholder: string
  /** May reject; the text then comes back into an empty box. */
  onSend: (text: string) => Promise<void> | void
  /** Shown as a Stop button while there is work to stop. */
  onStop?: () => void
  /** Accessible names, so a second composer on the screen (the side chat) is told apart. */
  label?: string
  sendLabel?: string
  /** Rendered at the start of the box. The reply chip uses this slot. */
  leading?: ReactNode
}) {
  const [value, setValue] = useState<ComposerValue>([])
  const [queryCharacter, setQueryCharacter] = useState<string | null>(null)
  const [skills, setSkills] = useState<ComposerSkill[]>([])
  const [files, setFiles] = useState<{ path: string }[]>([])

  useEffect(() => {
    let current = true
    void composerSkillsAction(filesProject ?? undefined)
      .then((next) => {
        if (current) setSkills(next)
      })
      .catch(() => {
        if (current) setSkills([])
      })
    return () => {
      current = false
    }
  }, [filesProject])

  useEffect(() => {
    if (!filesProject) {
      setFiles([])
      return
    }
    let current = true
    void projectFilesAction(filesProject)
      .then((next) => {
        if (current) setFiles(next)
      })
      .catch(() => {
        if (current) setFiles([])
      })
    return () => {
      current = false
    }
  }, [filesProject])

  // A chosen row becomes a token. getComposerText sends `text` when it is set
  // (a Codex skill is `$name`, a Claude skill is `/name`) and otherwise the
  // trigger plus the label. Plain text would match the query again and reopen
  // the picker, so the next Enter would pick instead of send.
  const projectItems: ComposerItemValue[] = projects.map((name) => ({ id: `project:${name}`, label: name, kind: 'project' }))
  const fileItems: ComposerItemValue[] = files.map((file) => {
    const slash = Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\'))
    return {
      id: `file:${file.path}`,
      label: slash === -1 ? file.path : file.path.slice(slash + 1),
      description: file.path,
      kind: 'file',
      text: `@${file.path}`,
    }
  })
  const skillItems: ComposerItemValue[] = skills.map((skill) => ({
    id: `skill:${skill.name}`,
    label: skill.name,
    description: skill.description,
    kind: 'skill',
    text: skill.invocation,
  }))
  const commandItems: ComposerItemValue[] = showCommands
    ? [
        { id: 'command:new-task', label: 'new task', description: 'Start a task in one project.', kind: 'command', type: 'text', text: 'Create a task: ' },
        {
          id: 'command:stop',
          label: 'stop',
          description: 'Stop the reply that is running.',
          kind: 'command',
          type: 'action',
          disabled: !canStop,
        },
        {
          id: 'command:archive',
          label: 'archive',
          description: 'Put away the task you are messaging.',
          kind: 'command',
          type: 'action',
          disabled: !canArchive,
        },
      ]
    : []

  function change(next: ComposerValue) {
    const command = next.find((part) => part.type === 'action' && part.kind === 'command')
    if (command && command.type === 'action') {
      if (command.id === 'command:stop') onCommand?.('stop')
      if (command.id === 'command:archive') onCommand?.('archive')
      setValue(next.filter((part) => part !== command))
      return
    }
    setValue(next)
  }

  function send(draft: ComposerValue) {
    const message = getComposerText(draft).trim()
    if (!message) return
    setValue([])
    Promise.resolve(onSend(message)).catch(() => {
      // Bring the message back only if nothing new was typed meanwhile.
      setValue((current) => (getComposerText(current).trim() ? current : [{ type: 'text', text: message }]))
    })
  }

  const fileMentions = Boolean(filesProject)
  const listLabel =
    queryCharacter === '/' ? 'Choose a skill or command' : fileMentions ? 'Choose a file' : 'Choose a project'

  return (
    <Composer
      value={value}
      onValueChange={change}
      onSubmit={send}
      onQueryChange={(query) => setQueryCharacter(query?.character ?? null)}
      triggers={[
        { character: '@', items: fileMentions ? fileItems : projectItems, filter: fileMentions ? fuzzyMatch : undefined },
        { character: '/', items: [...skillItems, ...commandItems], filter: fuzzyMatch },
      ]}
    >
      {leading && <div className="px-1 pt-1">{leading}</div>}
      <ComposerInput aria-label={label} placeholder={placeholder} />
      <ComposerPopup className="overflow-hidden border-zinc-700 shadow-xl">
        <div className="mention-menu">
        <ComposerList aria-label={listLabel}>
          {(item: ComposerItemValue) => (
            <ComposerItem key={item.id} value={item} className="text-inherit">
              <PickerRow item={item} prefix={item.kind === 'project' ? '@' : undefined} />
            </ComposerItem>
          )}
        </ComposerList>
        </div>
      </ComposerPopup>
      <ComposerActions>
        <ComposerActionGroup align="end">
          {onStop && (
            <Button type="button" variant="outline" size="icon-sm" aria-label="Stop" onClick={onStop}>
              <Square />
            </Button>
          )}
          <ComposerSubmit
            render={
              <Button size="icon-sm" aria-label={sendLabel}>
                <ArrowUp />
              </Button>
            }
          />
        </ComposerActionGroup>
      </ComposerActions>
    </Composer>
  )
}

function PickerRow({ item, prefix }: { item: ComposerItemValue; prefix?: string }) {
  const kind = item.kind === 'skill' ? 'Skill' : item.kind === 'command' ? 'Command' : null
  return (
    <span className="flex min-w-0 flex-1 flex-col py-0.5">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-medium">
          {prefix}
          {item.label}
        </span>
        {kind && <span className="shrink-0 text-[10px] tracking-wide uppercase opacity-50">{kind}</span>}
      </span>
      {item.description && <span className="truncate text-xs opacity-60">{item.description}</span>}
    </span>
  )
}

/** The query's letters appear in order in the name, or the description contains the query. */
function fuzzyMatch(item: ComposerItemValue, query: string) {
  const needle = query.toLowerCase().replace(/\s+/g, '')
  if (!needle) return true
  const label = item.label.toLowerCase()
  let from = 0
  let named = true
  for (const character of needle) {
    const found = label.indexOf(character, from)
    if (found === -1) {
      named = false
      break
    }
    from = found + 1
  }
  return named || (item.description ?? '').toLowerCase().includes(needle)
}
