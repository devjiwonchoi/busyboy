import type { Metadata } from 'next'
import { connection } from 'next/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { CompanionSettings } from '@/components/settings/companion-settings'
import { DefaultAgent } from '@/components/settings/default-agent'
import { AddProjectForm } from '@/components/setup/add-project-form'
import { AlwaysAskForm } from '@/components/setup/always-ask-form'
import { CompanionImageForm } from '@/components/setup/companion-step'
import { CopyCommand } from '@/components/setup/copy-command'
import { FolderPicker } from '@/components/setup/folder-picker'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { alwaysAskRules } from '@/server/always-ask-list'
import { COMPANIONS, companionImageUrl, currentCompanion } from '@/server/companions'
import { isSetupComplete, readSettings } from '@/server/config'
import { defaultProvider, PROVIDERS, providerState, skillsState } from '@/server/providers'
import type { SignInStatus } from '@/server/runner/contract'
import { recheckProvidersAction, removeProjectAction, restoreAlwaysAskAction } from '@/app/setup/actions'
import { saveAlwaysAskAction } from './actions'
import { parseSection, sectionHref, SECTIONS, type SectionId } from './sections'

export const metadata: Metadata = { title: 'Settings · BusyBoy' }

// Settings after setup: one page with a section list, where each change saves on its own.
// Setup stays a guided first run; this page has no steps, Continue, or Back.
export default function SettingsPage({ searchParams }: PageProps<'/settings'>) {
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-10 shrink-0 items-center border-b pr-2 pl-[var(--title-bar-inset,0.75rem)] [app-region:drag]">
        <span className="text-sm font-medium">Settings</span>
        <Link href="/" className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'ml-auto [app-region:no-drag]' })}>
          Back to chat
        </Link>
      </header>
      <Suspense fallback={<Skeleton className="m-6 h-96" />}>
        <Body searchParams={searchParams} />
      </Suspense>
    </div>
  )
}

async function Body({ searchParams }: Pick<PageProps<'/settings'>, 'searchParams'>) {
  const section = parseSection((await searchParams).section)
  // Sections read local state (sign-in probes, files) per request.
  await connection()
  // Settings only exist once setup has been finished; until then setup is the way in.
  if (!isSetupComplete(await readSettings())) redirect('/setup')
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav aria-label="Settings sections" className="shrink-0 border-b p-2 md:w-48 md:border-r md:border-b-0">
        <ul className="flex gap-1 overflow-x-auto md:flex-col">
          {SECTIONS.map(({ id, title }) => (
            <li key={id}>
              <Link
                href={sectionHref(id)}
                aria-current={id === section ? 'page' : undefined}
                className={buttonVariants({ variant: id === section ? 'secondary' : 'ghost', size: 'sm', className: 'w-full justify-start' })}
              >
                {title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main aria-label="Settings" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-6 px-6 py-8">
          <Section id={section} />
        </div>
      </main>
    </div>
  )
}

const HEADINGS: Record<SectionId, { title: string; description: string }> = {
  companion: {
    title: 'Companion',
    description: 'Your director, the agent you chat with. Its personality shapes how it talks to you.',
  },
  agents: {
    title: 'Agents',
    description: 'BusyBoy uses the Claude Code and Codex CLIs you already have. It never signs in for you.',
  },
  approvals: {
    title: 'Approvals',
    description: 'Before any action on this list a task agent asks you first, every time, even in Auto mode.',
  },
  projects: {
    title: 'Projects',
    description: 'Folders that are git repositories. Removing one keeps its folder.',
  },
}

function Section({ id }: { id: SectionId }) {
  const { title, description } = HEADINGS[id]
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {id === 'companion' && <CompanionSection />}
      {id === 'agents' && <AgentsSection />}
      {id === 'approvals' && <ApprovalsSection />}
      {id === 'projects' && <ProjectsSection />}
    </>
  )
}

async function CompanionSection() {
  const [companion, imageUrl] = await Promise.all([currentCompanion(), companionImageUrl()])
  return (
    <>
      <CompanionSettings companions={COMPANIONS} selected={companion?.id} imageUrl={imageUrl} />
      <Separator />
      <CompanionImageForm hasImage={Boolean(imageUrl)} />
    </>
  )
}

const STATUS_TEXT: Record<SignInStatus['state'], string> = {
  'signed-in': 'Signed in',
  'signed-out': 'Signed out',
  'not-installed': 'Not installed',
  outdated: 'Update needed',
  unknown: 'Could not check',
}

async function AgentsSection() {
  const [agents, current] = await Promise.all([
    Promise.all(
      PROVIDERS.map(async (provider) => {
        const state = await providerState(provider.id)
        // Skills only matter for an agent BusyBoy can run.
        const skills = state.state === 'not-installed' ? null : await skillsState(provider.id)
        return { ...provider, state, skills }
      }),
    ),
    defaultProvider(),
  ])
  const signedIn = agents.filter(({ state }) => state.state === 'signed-in')
  return (
    <>
      <ItemGroup aria-label="Agents" className="gap-2">
        {agents.map(({ id, name, state, skills }) => (
          <Item key={id} role="listitem" variant="outline">
            <ItemContent>
              <ItemTitle>{name}</ItemTitle>
              {skills && (
                <ItemDescription>Skills plugin: {skills.installed ? 'installed' : 'not installed'}</ItemDescription>
              )}
            </ItemContent>
            <ItemActions>
              <Badge variant="secondary">{STATUS_TEXT[state.state]}</Badge>
            </ItemActions>
            {state.state === 'signed-out' && (
              <>
                <ItemDescription className="basis-full">Run this in a terminal, then choose Check again.</ItemDescription>
                <CopyCommand label={`${name} login command`} command={state.loginCommand} />
              </>
            )}
            {state.state === 'outdated' && (
              <>
                <ItemDescription className="basis-full line-clamp-none">{state.detail}</ItemDescription>
                <CopyCommand label={`${name} update command`} command={state.updateCommand} />
              </>
            )}
            {(state.state === 'not-installed' || state.state === 'unknown') && (
              <ItemDescription className="basis-full line-clamp-none">{state.detail}</ItemDescription>
            )}
            {skills && !skills.installed && <CopyCommand label={`${name} skills install command`} command={skills.installCommand} />}
          </Item>
        ))}
      </ItemGroup>
      <form action={recheckProvidersAction}>
        <Button type="submit" variant="outline" size="sm">
          Check again
        </Button>
      </form>
      {signedIn.length > 1 && <DefaultAgent agents={signedIn.map(({ id, name }) => ({ id, name }))} selected={current ?? undefined} />}
    </>
  )
}

const APPROVALS_FORM = 'approvals-form'

async function ApprovalsSection() {
  const rules = await alwaysAskRules()
  return (
    <>
      {/* Keyed by the list, so Restore defaults shows the restored text in the box. */}
      <AlwaysAskForm key={rules.join('\n')} id={APPROVALS_FORM} rules={rules} save={saveAlwaysAskAction} />
      <div className="flex justify-end gap-2">
        <form action={restoreAlwaysAskAction}>
          <Button type="submit" variant="ghost">
            Restore defaults
          </Button>
        </form>
        <Button type="submit" form={APPROVALS_FORM}>
          Save
        </Button>
      </div>
    </>
  )
}

async function ProjectsSection() {
  const { projects } = await readSettings()
  return (
    <>
      {projects.length === 0 ? (
        <Empty className="border p-4">
          <EmptyHeader>
            <EmptyDescription>No projects yet.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup aria-label="Projects" className="gap-2">
          {projects.map((project) => (
            <Item key={project.name} role="listitem" variant="outline">
              <ItemContent className="min-w-0">
                <ItemTitle>{project.name}</ItemTitle>
                <ItemDescription className="truncate">{project.path}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <form action={removeProjectAction.bind(null, project.name)}>
                  <Button type="submit" variant="ghost" size="sm" aria-label={`Remove ${project.name}`}>
                    Remove
                  </Button>
                </form>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
      <FolderPicker />
      <AddProjectForm />
    </>
  )
}
