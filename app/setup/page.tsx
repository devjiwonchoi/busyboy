import type { Metadata } from 'next'
import { connection } from 'next/server'
import Link from 'next/link'
import { Suspense } from 'react'
import { AddProjectForm } from '@/components/setup/add-project-form'
import { CopyCommand } from '@/components/setup/copy-command'
import { Button } from '@/components/ui/button'
import { isSetupComplete, readSettings } from '@/server/config'
import { defaultProvider, PROVIDERS, providerState, signedInProviders, skillsState, type ProviderState } from '@/server/providers'
import type { ProviderId } from '@/server/runner/contract'
import { recheckProvidersAction, removeProjectAction, setDefaultProviderAction, startChattingAction } from './actions'

export const metadata: Metadata = { title: 'Setup · Busyboy' }

// First-run setup, also reachable later from the title bar. Every section
// reads local state at request time, so each streams in its own boundary.
export default function SetupPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-10 shrink-0 items-center border-b pr-2 pl-[var(--title-bar-inset,0.75rem)] [app-region:drag]">
        <span className="text-sm font-medium">Busyboy</span>
      </header>
      <main aria-label="Setup" className="mx-auto w-full max-w-2xl flex-1 space-y-10 px-6 py-10">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Set up busyboy</h1>
          <p className="text-muted-foreground text-sm">
            Busyboy uses the Claude Code and Codex CLIs you already have. Sign in to one and add a project to start.
          </p>
        </div>

        <Section title="Providers" description="Busyboy never signs in for you. Run the login command in a terminal.">
          <ul aria-label="Providers" className="divide-y rounded-lg border">
            {PROVIDERS.map(({ id, name }) => (
              <li key={id} className="px-4 py-3">
                <Suspense fallback={<Row name={name} status="Checking…" />}>
                  <ProviderRow id={id} name={name} />
                </Suspense>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <form action={recheckProvidersAction}>
              <Button type="submit" variant="outline" size="sm">
                Check again
              </Button>
            </form>
            <Suspense>
              <DefaultProviderChoice />
            </Suspense>
          </div>
        </Section>

        <Section title="Skills" description="Agents work best with the jwn plugin from devjiwonchoi/skills.">
          <ul aria-label="Skills" className="divide-y rounded-lg border empty:hidden">
            {PROVIDERS.map(({ id, name }) => (
              <Suspense key={id}>
                <SkillsRow id={id} name={name} />
              </Suspense>
            ))}
          </ul>
          <Suspense>
            <NoRunnableProvider />
          </Suspense>
        </Section>

        <Section title="Projects" description="A project is a folder that is a git repository.">
          <Suspense fallback={<p className="text-muted-foreground text-sm">Loading projects…</p>}>
            <ProjectList />
          </Suspense>
          <AddProjectForm />
        </Section>

        <Suspense fallback={<StartButton ready={false} hint="Checking providers…" />}>
          <StartChatting />
        </Suspense>
      </main>
    </div>
  )
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  const id = `${title.toLowerCase()}-heading`
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h2 id={id} className="font-medium">
          {title}
        </h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </section>
  )
}

function Row({ name, status, children }: { name: string; status: string; children?: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground">{status}</span>
      </div>
      {children}
    </div>
  )
}

const STATUS_TEXT: Record<ProviderState['state'], string> = {
  'signed-in': 'Signed in',
  'signed-out': 'Signed out',
  'not-installed': 'Not installed',
  unavailable: 'Not supported yet',
  unknown: 'Could not check',
}

async function ProviderRow({ id, name }: { id: ProviderId; name: string }) {
  await connection()
  const state = await providerState(id)
  return (
    <Row name={name} status={STATUS_TEXT[state.state]}>
      {state.state === 'signed-out' && <CopyCommand label={`${name} login command`} command={state.loginCommand} />}
      {(state.state === 'not-installed' || state.state === 'unknown') && (
        <p className="text-muted-foreground text-xs">{state.detail}</p>
      )}
    </Row>
  )
}

async function DefaultProviderChoice() {
  await connection()
  const [signedIn, current] = await Promise.all([signedInProviders(), defaultProvider()])
  if (signedIn.length < 2) return null
  return (
    <div role="group" aria-label="Default provider" className="ml-auto flex items-center gap-1 text-sm">
      <span className="text-muted-foreground mr-1">Default</span>
      {PROVIDERS.filter(({ id }) => signedIn.includes(id)).map(({ id, name }) => (
        <form key={id} action={setDefaultProviderAction.bind(null, id)}>
          <Button type="submit" size="sm" variant={id === current ? 'secondary' : 'ghost'} aria-pressed={id === current}>
            {name}
          </Button>
        </form>
      ))}
    </div>
  )
}

async function SkillsRow({ id, name }: { id: ProviderId; name: string }) {
  await connection()
  const state = await providerState(id)
  // Only providers busyboy can run are listed.
  if (state.state === 'unavailable' || state.state === 'not-installed') return null
  const skills = await skillsState(id)
  return (
    <li className="px-4 py-3">
      <Row name={name} status={skills.installed ? 'Installed' : 'Not installed'}>
        {!skills.installed && <CopyCommand label={`${name} install command`} command={skills.installCommand} />}
      </Row>
    </li>
  )
}

async function NoRunnableProvider() {
  await connection()
  const states = await Promise.all(PROVIDERS.map(({ id }) => providerState(id)))
  if (states.some(({ state }) => state !== 'unavailable' && state !== 'not-installed')) return null
  return <p className="text-muted-foreground text-sm">Install Claude Code or Codex first.</p>
}

async function ProjectList() {
  await connection()
  const { projects } = await readSettings()
  if (projects.length === 0) return <p className="text-muted-foreground text-sm">No projects yet.</p>
  return (
    <ul aria-label="Projects" className="divide-y rounded-lg border">
      {projects.map((project) => (
        <li key={project.name} className="flex items-center gap-4 px-4 py-3 text-sm">
          <div className="min-w-0 flex-1">
            <div className="font-medium">{project.name}</div>
            <div className="text-muted-foreground truncate text-xs">{project.path}</div>
          </div>
          <form action={removeProjectAction.bind(null, project.name)}>
            <Button type="submit" variant="ghost" size="sm" aria-label={`Remove ${project.name}`}>
              Remove
            </Button>
          </form>
        </li>
      ))}
    </ul>
  )
}

async function StartChatting() {
  await connection()
  const settings = await readSettings()
  // Opened later from the title bar: the way back never waits for a sign-in probe.
  if (isSetupComplete(settings)) {
    return (
      <div className="flex justify-end border-t pt-6">
        <Button asChild>
          <Link href="/">Back to chat</Link>
        </Button>
      </div>
    )
  }
  const { projects } = settings
  const signedIn = await signedInProviders()
  const hint =
    signedIn.length === 0 && projects.length === 0
      ? 'Sign in to a provider and add a project to continue.'
      : signedIn.length === 0
        ? 'Sign in to a provider to continue.'
        : projects.length === 0
          ? 'Add a project to continue.'
          : undefined
  return <StartButton ready={!hint} hint={hint} />
}

function StartButton({ ready, hint }: { ready: boolean; hint?: string }) {
  return (
    <form action={startChattingAction} className="flex items-center justify-end gap-3 border-t pt-6">
      {hint && <p className="text-muted-foreground text-sm">{hint}</p>}
      <Button type="submit" disabled={!ready}>
        Start chatting
      </Button>
    </form>
  )
}
