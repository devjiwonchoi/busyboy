import type { Metadata } from 'next'
import { connection } from 'next/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { ConnectorAddForm } from '@/components/settings/connector-add-form'
import { CompanionSettings } from '@/components/settings/companion-settings'
import { HarnessChoice } from '@/components/settings/harness-choice'
import { ThemeChoice } from '@/components/settings/theme-choice'
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
import { listConnectors, type ConnectorStatus } from '@/server/connectors'
import { COMPANIONS, companionImageUrl, currentCompanion } from '@/server/companions'
import { isSetupComplete, readSettings } from '@/server/config'
import { defaultProvider, PROVIDERS, providerState, skillsState } from '@/server/providers'
import { DEFAULT_ALWAYS_ASK } from '@/server/runner/always-ask'
import type { SignInStatus } from '@/server/runner/contract'
import { recheckProvidersAction, removeProjectAction, restoreAlwaysAskAction } from '@/app/setup/actions'
import { saveAlwaysAskAction } from './actions'
import { parseSection, sectionHref, SECTIONS, type SectionId } from './sections'

export const metadata: Metadata = { title: 'Settings · BusyBoy' }

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
  await connection()
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
    title: 'Director',
    description: 'The main agent who leads every manager. Pick a character. You can change it any time.',
  },
  appearance: {
    title: 'Appearance',
    description: 'BusyBoy starts in dark. System follows this device.',
  },
  agents: {
    title: 'Agents',
    description: 'BusyBoy uses the Claude Code, Codex, and Grok CLIs you already have. It never signs in for you. Every chat uses the harness you choose here.',
  },
  connectors: {
    title: 'Connectors',
    description: 'MCP servers configured for Claude Code and Codex. BusyBoy uses those sign-ins and does not keep a token of its own.',
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
      {id === 'appearance' && <AppearanceSection />}
      {id === 'agents' && <AgentsSection />}
      {id === 'connectors' && <ConnectorsSection />}
      {id === 'approvals' && <ApprovalsSection />}
      {id === 'projects' && <ProjectsSection />}
    </>
  )
}

async function AppearanceSection() {
  const { theme } = await readSettings()
  return <ThemeChoice selected={theme} />
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
        const skills = state.state === 'not-installed' ? null : await skillsState(provider.id)
        return { ...provider, state, skills }
      }),
    ),
    defaultProvider(),
  ])
  return (
    <>
      <section aria-label="Harness" className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Harness</h2>
          <p className="text-muted-foreground text-sm">Every chat uses this harness. The harness picks its model and effort.</p>
        </div>
        <HarnessChoice
          harnesses={agents.map(({ id, name, state }) => ({
            id,
            name,
            status: STATUS_TEXT[state.state],
            selectable: state.state === 'signed-in' || state.state === 'unknown',
          }))}
          selected={current ?? undefined}
        />
      </section>
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
    </>
  )
}

const CONNECTOR_STATUS: Record<ConnectorStatus, string> = {
  connected: 'Connected',
  'needs-login': 'Needs login',
  failed: 'Failed',
}

async function ConnectorsSection() {
  const harnesses = await listConnectors()
  return (
    <div className="space-y-8">
      {harnesses.map((harness) => (
        <section key={harness.provider} aria-label={`${harness.name} connectors`} className="space-y-4">
          <h2 className="text-sm font-medium">{harness.name}</h2>
          {harness.servers.length === 0 ? (
            <Empty className="border p-4">
              <EmptyHeader>
                <EmptyDescription>No connectors yet.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup aria-label={`${harness.name} servers`} className="gap-2">
              {harness.servers.map((server) => (
                <Item key={server.name} role="listitem" aria-label={server.name} variant="outline">
                  <ItemContent>
                    <ItemTitle>{server.name}</ItemTitle>
                    {server.detail && <ItemDescription className="line-clamp-none">{server.detail}</ItemDescription>}
                  </ItemContent>
                  <ItemActions>
                    <Badge variant={server.status === 'failed' ? 'destructive' : 'secondary'} data-status={server.status}>
                      {CONNECTOR_STATUS[server.status]}
                    </Badge>
                  </ItemActions>
                  {server.loginCommand && <CopyCommand label={`${server.name} login command`} command={server.loginCommand} />}
                </Item>
              ))}
            </ItemGroup>
          )}
          {harness.add.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-muted-foreground text-sm">Add a connector</h3>
              {harness.add.map((offer) => (
                <ConnectorAddForm key={offer.name} provider={harness.provider} name={offer.name} title={offer.title} command={offer.command} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

async function ApprovalsSection() {
  const rules = await alwaysAskRules()
  return <AlwaysAskForm id="approvals-form" rules={rules} save={saveAlwaysAskAction} restore={{ rules: DEFAULT_ALWAYS_ASK, action: restoreAlwaysAskAction }} />
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
