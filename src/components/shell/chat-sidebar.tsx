'use client'

import { AlertTriangle, CircleCheck, CircleHelp, Plus, Search, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useActionState, useEffect, useState, useSyncExternalStore } from 'react'
import { createManagerAction, removeManagerAction, type CreateManagerResult } from '@/app/(main)/manager-actions'
import { LetterMark, LetterStack, letterOf, PersonaAvatar, type Persona } from '@/components/chat/persona'
import { useProjectProgress, type ProjectProgress } from '@/components/chat/task-phases'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldTitle } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ItemGroup } from '@/components/ui/item'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { desktopBridge } from '@/lib/desktop-bridge'
import { cn } from '@/lib/utils'
import type { ChatSummary } from '@/server/director/chat'
import type { TaskProgress } from '@/server/records/progress'
import type { Room } from '@/server/rooms'

const NEW_FOLDER = '\0new-folder'
const ROOM = '\0room'

const managerHref = (id: string) => `/?manager=${encodeURIComponent(id)}`

export function ChatSidebar({
  director,
  projects,
  rooms,
  userName,
}: {
  director: Persona
  projects: string[]
  rooms: Room[]
  userName: string
}) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const active = useSearchParams().get('manager')
  const recordProgress = useProjectProgress()

  useEffect(() => {
    const source = new EventSource('/api/chats/events')
    source.onmessage = (message) => setChats(JSON.parse(message.data) as ChatSummary[])
    return () => source.close()
  }, [])

  const directorChat = chats?.find(({ chat }) => chat === null)
  const managers = chats?.filter(({ chat }) => chat !== null) ?? []
  const managed = new Set(managers.map(({ project }) => project?.toLowerCase()))
  const needle = query.trim().toLowerCase()
  const visibleManagers = needle ? managers.filter((manager) => matches(needle, manager.name, manager.preview, manager.project)) : managers
  const visibleRooms = needle ? rooms.filter((room) => matches(needle, room.name, room.projects.join(' '))) : rooms

  return (
    <nav
      aria-label="Chats"
      data-loaded={chats !== null}
      className="hidden h-full w-[17rem] shrink-0 flex-col border-r bg-background text-foreground md:flex dark:border-white/8 dark:bg-[#161617] dark:text-white"
    >
      <div className="flex h-10 items-center justify-end gap-0.5 px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Search chats"
          aria-pressed={searching}
          className="text-[#8d8d93] hover:bg-white/5 hover:text-white"
          onClick={() => {
            setSearching((open) => !open)
            if (searching) setQuery('')
          }}
        >
          <Search />
        </Button>
        <NewManager projects={projects} taken={managed} />
      </div>
      {searching && (
        <div className="px-2 pb-1">
          <Input
            aria-label="Search chats"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            autoFocus
            className="h-8 border-white/10 bg-white/5 text-sm"
          />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-1">
        {/* Stays at the top of the list while the rows below scroll. */}
        <div className="sticky top-0 z-10 bg-background pb-1 dark:bg-[#161617]">
          <DirectorRow director={director} chat={directorChat} active={active === null} progress={recordProgress} />
        </div>
        <ItemGroup aria-label="Managers" className="gap-0.5">
          {visibleManagers.map((manager) => (
            <ManagerItem key={manager.chat} manager={manager} active={manager.chat === active} progress={progressOf(recordProgress.projects, manager.project)} />
          ))}
          {visibleRooms.map((room) => (
            <RoomItem key={room.id} room={room} managers={managers} />
          ))}
        </ItemGroup>
        {chats !== null && managers.length === 0 && rooms.length === 0 && (
          <p className="text-muted-foreground px-2 py-2 text-xs">No managers yet. Create one for a project to talk to it here.</p>
        )}
      </div>
      <div className="flex items-center gap-2.5 px-3 py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#3a3a40] text-xs font-medium text-white" aria-hidden>
          {letterOf(userName)}
        </span>
        <span className="truncate text-sm text-foreground dark:text-zinc-200">{userName}</span>
      </div>
    </nav>
  )
}

function matches(needle: string, ...parts: Array<string | null | undefined>) {
  return parts.some((part) => part?.toLowerCase().includes(needle))
}

function statusLine(chat: ChatSummary | undefined, fallback: string) {
  const waiting = chat?.waiting ?? 0
  if (waiting > 0) return waiting === 1 ? '1 thing waiting for you' : `${waiting} things waiting for you`
  if (chat?.status === 'answering') return 'Replying…'
  return chat?.preview || fallback
}

function progressOf(projects: ProjectProgress[], name: string | null) {
  if (!name) return undefined
  const key = name.toLowerCase()
  return projects.find((project) => project.name.toLowerCase() === key)?.progress
}

type ProgressMark = 'complete' | 'at-risk' | 'decision'

const MARK: Record<ProgressMark, { icon: typeof CircleCheck; label: string; className: string }> = {
  complete: { icon: CircleCheck, label: 'All verified', className: 'text-success-foreground' },
  'at-risk': { icon: AlertTriangle, label: 'At risk', className: 'text-destructive' },
  decision: { icon: CircleHelp, label: 'Needs a decision', className: 'text-warning-foreground' },
}

function directorMarks(total: TaskProgress, projects: ProjectProgress[]): ProgressMark[] {
  const states = new Set(projects.filter((project) => project.progress.total > 0).map((project) => project.progress.state))
  const marks: ProgressMark[] = []
  if (states.has('at-risk')) marks.push('at-risk')
  if (states.has('decision')) marks.push('decision')
  if (marks.length === 0 && total.total > 0 && total.verified === total.total) marks.push('complete')
  return marks
}

function projectMark(progress: TaskProgress): ProgressMark | null {
  if (progress.total === 0) return null
  if (progress.state === 'at-risk') return 'at-risk'
  if (progress.state === 'decision') return 'decision'
  if (progress.verified === progress.total) return 'complete'
  return null
}

function directorLabel(name: string, total: TaskProgress, marks: ProgressMark[]) {
  if (total.total === 0) return `${name}, director`
  return [`${name}, director`, ...marks.map((mark) => MARK[mark].label), `${total.verified}/${total.total}`].join(', ')
}

function Fraction({ progress }: { progress: TaskProgress }) {
  return (
    <span className="tabular-nums">
      {progress.verified}/{progress.total}
    </span>
  )
}

function StatusIcon({ mark }: { mark: ProgressMark }) {
  const { icon: Icon, label, className } = MARK[mark]
  return (
    <Icon data-state={mark} role="img" aria-label={label} className={cn('size-3.5 shrink-0', className)}>
      <title>{label}</title>
    </Icon>
  )
}

function ManagerProgress({ progress }: { progress: TaskProgress }) {
  const mark = projectMark(progress)
  return <ProgressReadout progress={progress} marks={mark ? [mark] : []} />
}

function ProgressReadout({ progress, marks }: { progress: TaskProgress; marks: ProgressMark[] }) {
  if (progress.total === 0) return null
  return (
    <span data-progress={`${progress.verified}/${progress.total}`} className="inline-flex shrink-0 items-center gap-1 text-[11px] leading-none whitespace-nowrap text-[#8d8d93]">
      {marks.map((mark) => (
        <StatusIcon key={mark} mark={mark} />
      ))}
      <Fraction progress={progress} />
    </span>
  )
}

function DirectorRow({
  director,
  chat,
  active,
  progress,
}: {
  director: Persona
  chat: ChatSummary | undefined
  active: boolean
  progress: { projects: ProjectProgress[]; total: TaskProgress }
}) {
  const line = statusLine(chat, 'Leads every manager')
  const marks = directorMarks(progress.total, progress.projects)
  return (
    <Link
      href="/"
      aria-current={active ? 'page' : undefined}
      aria-label={directorLabel(director.name, progress.total, marks)}
      className={cn('flex items-center gap-2.5 rounded-xl px-2 py-1.5', active && 'bg-muted dark:bg-[#232325]')}
    >
      {director.mark && <PersonaAvatar persona={director} className="size-10 text-xl" />}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[15px] leading-5 font-semibold">{director.name}</span>
          <Badge className="h-[18px] shrink-0 border-transparent bg-violet-500/25 px-1.5 text-[10px] font-medium text-violet-200">Director</Badge>
        </span>
        <span className={cn('block truncate text-[13px] leading-4 text-[#8d8d93]', chat?.status === 'answering' && chat.waiting === 0 && 'animate-pulse')}>
          {line}
        </span>
      </span>
      <ProgressReadout progress={progress.total} marks={marks} />
    </Link>
  )
}

function ManagerItem({ manager, active, progress }: { manager: ChatSummary; active: boolean; progress: TaskProgress | undefined }) {
  const id = manager.chat!
  return (
    <div role="listitem" aria-label={manager.name} className="group/manager relative">
      <Link
        href={managerHref(id)}
        aria-current={active ? 'page' : undefined}
        className={cn('flex items-center gap-2.5 rounded-xl px-2 py-1.5', active && 'bg-muted dark:bg-[#232325]')}
      >
        <LetterMark name={manager.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] leading-5 font-semibold">{manager.name}</span>
          <span className="block truncate text-[13px] leading-4 text-[#8d8d93]">{statusLine(manager, manager.project ?? '')}</span>
        </span>
        {/* Hover brings the remove control up over this corner. Focusing the row itself leaves the count in place. */}
        {progress && progress.total > 0 && (
          <span className="group-hover/manager:invisible">
            <ManagerProgress progress={progress} />
          </span>
        )}
      </Link>
      {/* Above the row's link. Shown on hover, or when the control itself is focused. */}
      <div className="pointer-events-none absolute top-1/2 right-2 z-10 -translate-y-1/2 opacity-0 group-hover/manager:pointer-events-auto group-hover/manager:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <RemoveManager id={id} name={manager.name} project={manager.project ?? ''} active={active} />
      </div>
    </div>
  )
}

function RoomItem({ room, managers }: { room: Room; managers: ChatSummary[] }) {
  const names = room.projects.map((project) => managers.find((manager) => manager.project?.toLowerCase() === project.toLowerCase())?.name ?? project)
  return (
    <div role="listitem" aria-label={room.name} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
      <LetterStack names={names} />
      <span className="min-w-0">
        <span className="block truncate text-[15px] leading-5 font-semibold">{room.name}</span>
        <span className="block truncate text-[13px] leading-4 text-[#8d8d93]">{room.projects.join(' · ')}</span>
      </span>
    </div>
  )
}

function RemoveManager({ id, name, project, active }: { id: string; name: string; project: string; active: boolean }) {
  const router = useRouter()
  const [error, setError] = useState(false)
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Remove ${name}`} />}>
        <Trash2 />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {name} stops, and its tasks show in the Director&apos;s chat from now on. The {project} project and its tasks stay.
            {error && ' It could not be removed. Try again.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() =>
              void removeManagerAction(id).then(
                () => active && router.push('/'),
                () => setError(true),
              )
            }
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function subscribeNothing() {
  return () => {}
}

function NewManager({ projects, taken }: { projects: string[]; taken: Set<string | undefined> }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [project, setProject] = useState<string | null>(null)
  const [folder, setFolder] = useState('')
  const [roomProjects, setRoomProjects] = useState<string[]>([])
  const [state, action, pending] = useActionState<CreateManagerResult, FormData>(async (previous, form) => {
    const result = await createManagerAction(previous, form)
    if (result.id) {
      setOpen(false)
      setProject(null)
      setFolder('')
      setRoomProjects([])
      if (result.kind !== 'room') router.push(managerHref(result.id))
      router.refresh()
    }
    return result
  }, {})
  const free = projects.filter((name) => !taken.has(name.toLowerCase()))
  const choice = project ?? (free.length === 0 && projects.length < 2 ? NEW_FOLDER : null)
  // Read after hydration: the server never has the bridge, so the first render matches it.
  const bridge = useSyncExternalStore(subscribeNothing, desktopBridge, () => undefined)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={<SheetTrigger render={<Button variant="ghost" size="icon-sm" aria-label="New manager" className="text-[#8d8d93] hover:bg-white/5 hover:text-white" />} />}
        >
          <Plus />
        </TooltipTrigger>
        <TooltipContent>New manager</TooltipContent>
      </Tooltip>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>New manager</SheetTitle>
          <SheetDescription>A manager looks after one project. Talk to it to get work done there.</SheetDescription>
        </SheetHeader>
        <form id="new-manager" action={action} className="flex flex-col gap-4 px-6">
          <Field>
            <FieldLabel htmlFor="manager-name">Name</FieldLabel>
            <Input id="manager-name" name="name" maxLength={40} autoComplete="off" required={choice === ROOM} placeholder="The project's name" />
          </Field>
          <RadioGroup
            aria-label="Project"
            // null, not undefined, keeps the group controlled before the first choice.
            value={choice}
            onValueChange={(next) => setProject(next as string)}
          >
            {free.map((name) => (
              <FieldLabel key={name} htmlFor={`manager-project-${name}`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{name}</FieldTitle>
                  </FieldContent>
                  <RadioGroupItem value={name} id={`manager-project-${name}`} />
                </Field>
              </FieldLabel>
            ))}
            {projects.length >= 2 && (
              <FieldLabel htmlFor="manager-project-room">
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>Several projects</FieldTitle>
                    <FieldDescription>A room. Its row stacks those projects&apos; letters.</FieldDescription>
                  </FieldContent>
                  <RadioGroupItem value={ROOM} id="manager-project-room" />
                </Field>
              </FieldLabel>
            )}
            <FieldLabel htmlFor="manager-project-new">
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>Another folder</FieldTitle>
                  <FieldDescription>A git repository BusyBoy does not know yet.</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={NEW_FOLDER} id="manager-project-new" />
              </Field>
            </FieldLabel>
          </RadioGroup>
          {choice !== null && choice !== NEW_FOLDER && choice !== ROOM && <input type="hidden" name="project" value={choice} />}
          {choice === ROOM && (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Projects in the room</legend>
              <input type="hidden" name="kind" value="room" />
              {projects.map((name) => (
                <label key={name} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="projects"
                    value={name}
                    checked={roomProjects.includes(name)}
                    onChange={(event) =>
                      setRoomProjects((current) => (event.target.checked ? [...current, name] : current.filter((project) => project !== name)))
                    }
                  />
                  {name}
                </label>
              ))}
            </fieldset>
          )}
          {choice === NEW_FOLDER && (
            <Field>
              <FieldLabel htmlFor="manager-folder">Folder path</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="manager-folder"
                  name="folder"
                  required
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                  placeholder="~/code/my-app"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
                {bridge && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void bridge.pickFolders().then(([picked]) => picked && setFolder(picked), () => {})}
                  >
                    Choose…
                  </Button>
                )}
              </div>
            </Field>
          )}
          {state.error && <FieldError>{state.error}</FieldError>}
        </form>
        <SheetFooter>
          <Button type="submit" form="new-manager" disabled={pending || choice === null || (choice === ROOM && roomProjects.length < 2)}>
            {choice === ROOM ? 'Create room' : 'Create manager'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
