'use client'

import { Plus, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useActionState, useEffect, useState, useSyncExternalStore } from 'react'
import { createManagerAction, removeManagerAction, type CreateManagerResult } from '@/app/(main)/manager-actions'
import { managerPersona, PersonaAvatar, type Persona } from '@/components/chat/persona'
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
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { desktopBridge } from '@/lib/desktop-bridge'
import type { ChatSummary } from '@/server/director/chat'

/** The radio value for a repository BusyBoy does not know yet. */
const NEW_FOLDER = '\0new-folder'

const managerHref = (id: string) => `/?manager=${encodeURIComponent(id)}`

/**
 * The chat list on the left: the Director pinned on top, then one manager per
 * project, each with an emoji picture and the start of its latest message.
 * The list follows /api/chats/events; `projects` are the projects BusyBoy knows, for New manager.
 */
export function ChatSidebar({ director, projects }: { director: Persona; projects: string[] }) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const active = useSearchParams().get('manager')

  useEffect(() => {
    const source = new EventSource('/api/chats/events')
    source.onmessage = (message) => setChats(JSON.parse(message.data) as ChatSummary[])
    return () => source.close()
  }, [])

  const directorChat = chats?.find(({ chat }) => chat === null)
  const managers = chats?.filter(({ chat }) => chat !== null) ?? []
  const managed = new Set(managers.map(({ project }) => project?.toLowerCase()))

  return (
    <nav aria-label="Chats" data-loaded={chats !== null} className="hidden h-full w-64 shrink-0 flex-col border-r bg-background md:flex">
      <div className="flex items-center justify-end px-2 pt-2">
        <NewManager projects={projects.filter((name) => !managed.has(name.toLowerCase()))} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
        {/* Stays at the top of the list while the managers below scroll. */}
        <div className="sticky top-0 z-10 bg-background pb-1">
          <Item
            size="sm"
            variant={active === null ? 'muted' : 'default'}
            // A link styled as an item, so the Director's chat opens like any page.
            render={<Link href="/" aria-current={active === null ? 'page' : undefined} aria-label={`${director.name}, director`} />}
          >
            {director.mark && (
              <ItemMedia>
                <PersonaAvatar persona={director} className="size-9" />
              </ItemMedia>
            )}
            <ItemContent className="min-w-0">
              <ItemTitle className="line-clamp-none w-full min-w-0 gap-1.5">
                <span className="truncate">{director.name}</span>
                <Badge variant="secondary" className="h-4 shrink-0 border-transparent bg-violet-500/15 px-1.5 text-violet-700 dark:bg-violet-400/15 dark:text-violet-200">
                  Director
                </Badge>
              </ItemTitle>
              <ChatSubtitle chat={directorChat} fallback="Leads every manager" />
            </ItemContent>
          </Item>
        </div>
        <ItemGroup aria-label="Managers" className="gap-0.5">
          {managers.map((manager) => (
            <ManagerItem key={manager.chat} manager={manager} active={manager.chat === active} />
          ))}
        </ItemGroup>
        {chats !== null && managers.length === 0 && (
          <p className="text-muted-foreground px-2 text-xs">No managers yet. Create one for a project to talk to it here.</p>
        )}
      </div>
    </nav>
  )
}

/** The one line under a chat's name: work waiting on the user, a reply in progress, or the latest message. */
function ChatSubtitle({ chat, fallback }: { chat: ChatSummary | undefined; fallback: string }) {
  const waiting = chat?.waiting ?? 0
  const text =
    waiting > 0 ? (waiting === 1 ? '1 thing waiting for you' : `${waiting} things waiting for you`) : chat?.status === 'answering' ? 'Replying…' : chat?.preview || fallback
  return (
    <ItemDescription className="line-clamp-1">
      {chat?.status === 'answering' && waiting === 0 ? <span className="animate-pulse">{text}</span> : text}
    </ItemDescription>
  )
}

function ManagerItem({ manager, active }: { manager: ChatSummary; active: boolean }) {
  const id = manager.chat!
  return (
    <Item role="listitem" aria-label={manager.name} size="sm" variant={active ? 'muted' : 'default'} className="group/manager relative">
      <ItemMedia>
        <PersonaAvatar persona={managerPersona(manager.name)} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>
          {/* The link covers the whole item (after:inset-0), so the row opens the chat wherever it is clicked. */}
          <Link href={managerHref(id)} aria-current={active ? 'page' : undefined} className="after:absolute after:inset-0">
            {manager.name}
          </Link>
        </ItemTitle>
        <ChatSubtitle chat={manager} fallback={manager.project ?? ''} />
      </ItemContent>
      {/* Above the row's link, and shown on hover or keyboard focus. */}
      <ItemActions className="relative z-10 opacity-0 group-focus-within/manager:opacity-100 group-hover/manager:opacity-100">
        <RemoveManager id={id} name={manager.name} project={manager.project ?? ''} active={active} />
      </ItemActions>
    </Item>
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

/** The + button and its form: a name, and the project the manager looks after. */
function NewManager({ projects }: { projects: string[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [state, action, pending] = useActionState<CreateManagerResult, FormData>(async (previous, form) => {
    const result = await createManagerAction(previous, form)
    if (result.id) {
      setOpen(false)
      // The next manager starts from an empty form, not this one's project.
      setProject(null)
      setFolder('')
      // Refreshed too: a repository added with the manager is a new project for the next form.
      router.push(managerHref(result.id))
      router.refresh()
    }
    return result
  }, {})
  // With no project left to pick, the form asks for a folder at once.
  const [project, setProject] = useState<string | null>(null)
  const choice = project ?? (projects.length === 0 ? NEW_FOLDER : null)
  const [folder, setFolder] = useState('')
  // Read after hydration: the server never has the bridge, so the first render matches it.
  const bridge = useSyncExternalStore(subscribeNothing, desktopBridge, () => undefined)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<SheetTrigger render={<Button variant="ghost" size="icon-sm" aria-label="New manager" />} />}>
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
            <Input id="manager-name" name="name" maxLength={40} autoComplete="off" placeholder="The project's name" />
          </Field>
          <RadioGroup
            aria-label="Project"
            // null, not undefined, keeps the group controlled before the first choice.
            value={choice}
            onValueChange={(next) => setProject(next as string)}
          >
            {projects.map((name) => (
              <FieldLabel key={name} htmlFor={`manager-project-${name}`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{name}</FieldTitle>
                  </FieldContent>
                  <RadioGroupItem value={name} id={`manager-project-${name}`} />
                </Field>
              </FieldLabel>
            ))}
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
          {choice !== null && choice !== NEW_FOLDER && <input type="hidden" name="project" value={choice} />}
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
          <Button type="submit" form="new-manager" disabled={pending || choice === null}>
            Create manager
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
