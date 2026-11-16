import type { Metadata } from 'next'
import { connection } from 'next/server'
import Link from 'next/link'
import { Suspense } from 'react'
import { AddProjectForm } from '@/components/setup/add-project-form'
import { CompanionStep } from '@/components/setup/companion-step'
import { CopyCommand } from '@/components/setup/copy-command'
import { FolderPicker } from '@/components/setup/folder-picker'
import { SetupSteps } from '@/components/setup/setup-steps'
import { StepFooter } from '@/components/setup/step-footer'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Field, FieldContent, FieldLabel, FieldTitle } from '@/components/ui/field'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { COMPANIONS, companionImageUrl, currentCompanion } from '@/server/companions'
import { isSetupComplete, readSettings } from '@/server/config'
import { defaultProvider, PROVIDERS, providerState, signedInProviders, skillsState, type ProviderState } from '@/server/providers'
import { continueFromAgentsAction, recheckProvidersAction, removeProjectAction, startChattingAction } from './actions'
import { neighborSteps, parseStep, stepHref, STEPS, type StepId } from './steps'

export const metadata: Metadata = { title: 'Setup · BusyBoy' }

// First-run setup, one step at a time, also reachable later from the title
// bar. Steps read local state at request time, so they render inside Suspense
// (Cache Components would otherwise try to prerender them at build time).
export default function SetupPage({ searchParams }: PageProps<'/setup'>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-10 shrink-0 items-center border-b pr-2 pl-[var(--title-bar-inset,0.75rem)] [app-region:drag]">
        <span className="text-sm font-medium">BusyBoy</span>
        <Suspense>
          <BackToChat />
        </Suspense>
      </header>
      <main aria-label="Setup" className="mx-auto w-full max-w-2xl flex-1 space-y-8 px-6 py-10">
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <CurrentStep searchParams={searchParams} />
        </Suspense>
      </main>
    </div>
  )
}

/** Opened later from the title bar: the way back never waits for a sign-in probe. */
async function BackToChat() {
  await connection()
  if (!isSetupComplete(await readSettings())) return null
  return (
    <Link href="/" className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'ml-auto [app-region:no-drag]' })}>
      Back to chat
    </Link>
  )
}

const HEADINGS: Record<StepId, { title: string; description: string }> = {
  companion: {
    title: 'Choose your companion',
    description: 'Your companion becomes your director: the agent you chat with, who hands work to other agents. Its personality shapes how it talks to you.',
  },
  agents: {
    title: 'Sign in to an agent',
    description: 'BusyBoy uses the Claude Code and Codex CLIs you already have. It never signs in for you.',
  },
  skills: {
    title: 'Add skills',
    description: 'Agents work best with the jwn plugin from devjiwonchoi/skills. You can skip this and add it later.',
  },
  start: {
    title: 'Add projects',
    description:
      'A project is a folder that is a git repository. Add some now, or start without one and add it when a task needs it.',
  },
}

async function CurrentStep({ searchParams }: Pick<PageProps<'/setup'>, 'searchParams'>) {
  const step = parseStep((await searchParams).step)
  // Awaiting searchParams alone still lets Next prerender this part at request
  // time, which rejects the clock reads in providerState; this renders it per request.
  await connection()
  const { title, description } = HEADINGS[step]
  const index = STEPS.findIndex(({ id }) => id === step)
  return (
    <>
      <SetupSteps current={step} />
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">
          Step {index + 1} of {STEPS.length}
        </p>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {step === 'companion' && <CompanionPage />}
      {step === 'agents' && <AgentsPage />}
      {step === 'skills' && <SkillsPage />}
      {step === 'start' && <StartPage />}
    </>
  )
}

// ---- Companion --------------------------------------------------------------

async function CompanionPage() {
  const [companion, imageUrl] = await Promise.all([currentCompanion(), companionImageUrl()])
  return <CompanionStep companions={COMPANIONS} selected={companion?.id} imageUrl={imageUrl} />
}

// ---- Agents -----------------------------------------------------------------

const STATUS_TEXT: Record<ProviderState['state'], string> = {
  'signed-in': 'Signed in',
  'signed-out': 'Signed out',
  'not-installed': 'Not installed',
  unavailable: 'Not supported yet',
  unknown: 'Could not check',
}

const AGENTS_FORM = 'agents-form'

async function AgentsPage() {
  const { previous } = neighborSteps('agents')
  const [states, current] = await Promise.all([
    Promise.all(PROVIDERS.map(async (provider) => ({ ...provider, state: await providerState(provider.id) }))),
    defaultProvider(),
  ])
  const signedIn = states.filter(({ state }) => state.state === 'signed-in')
  return (
    <>
      <ItemGroup aria-label="Agents" className="gap-2">
        {states.map(({ id, name, state }) => (
          <Item key={id} role="listitem" variant="outline">
            <Row name={name} status={STATUS_TEXT[state.state]} />
            {state.state === 'signed-out' && (
              <>
                {/* Setup is its own screen outside the app shell, so the terminal panel isn't here; the user copies the command. */}
                <ItemDescription className="basis-full">Run this in a terminal, then choose Check again.</ItemDescription>
                <CopyCommand label={`${name} login command`} command={state.loginCommand} />
              </>
            )}
            {(state.state === 'not-installed' || state.state === 'unknown') && (
              <ItemDescription className="basis-full line-clamp-none">{state.detail}</ItemDescription>
            )}
          </Item>
        ))}
      </ItemGroup>
      <form action={recheckProvidersAction}>
        <Button type="submit" variant="outline" size="sm">
          Check again
        </Button>
      </form>
      {/* One form for the choice and Continue, so Continue saves the default agent. */}
      <form id={AGENTS_FORM} action={continueFromAgentsAction} className="space-y-2">
        {signedIn.length > 1 && (
          <RadioGroup name="defaultProvider" aria-label="Default agent" defaultValue={current ?? undefined}>
            {signedIn.map(({ id, name }) => (
              <FieldLabel key={id} htmlFor={`default-${id}`}>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>Use {name} by default</FieldTitle>
                  </FieldContent>
                  <RadioGroupItem value={id} id={`default-${id}`} />
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>
        )}
      </form>
      <StepFooter previous={previous} hint={signedIn.length === 0 ? 'Sign in to an agent to continue.' : undefined}>
        <Button type="submit" form={AGENTS_FORM} disabled={signedIn.length === 0}>
          Continue
        </Button>
      </StepFooter>
    </>
  )
}

/** Name and status badge inside an item. */
function Row({ name, status }: { name: string; status: string }) {
  return (
    <>
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <Badge variant="secondary">{status}</Badge>
      </ItemActions>
    </>
  )
}

// ---- Skills -----------------------------------------------------------------

async function SkillsPage() {
  const { previous, next } = neighborSteps('skills')
  const rows = await Promise.all(
    PROVIDERS.map(async ({ id, name }) => {
      const state = await providerState(id)
      // Only agents BusyBoy can run are listed.
      if (state.state === 'unavailable' || state.state === 'not-installed') return null
      return { id, name, skills: await skillsState(id) }
    }),
  )
  const runnable = rows.filter((row) => row !== null)
  const nextHref = stepHref(next!)
  return (
    <>
      {runnable.length === 0 ? (
        <p className="text-muted-foreground text-sm">Install Claude Code or Codex first.</p>
      ) : (
        <ItemGroup aria-label="Skills" className="gap-2">
          {runnable.map(({ id, name, skills }) => (
            <Item key={id} role="listitem" variant="outline">
              <Row name={name} status={skills.installed ? 'Installed' : 'Not installed'} />
              {!skills.installed && <CopyCommand label={`${name} install command`} command={skills.installCommand} />}
            </Item>
          ))}
        </ItemGroup>
      )}
      <StepFooter previous={previous}>
        <Link href={nextHref} className={buttonVariants({ variant: 'ghost' })}>
          Skip
        </Link>
        <Link href={nextHref} className={buttonVariants()}>
          Continue
        </Link>
      </StepFooter>
    </>
  )
}

// ---- Start ------------------------------------------------------------------

async function StartPage() {
  const { previous } = neighborSteps('start')
  const [{ projects }, signedIn, companion] = await Promise.all([readSettings(), signedInProviders(), currentCompanion()])
  const hint = !companion ? 'Choose a companion first.' : signedIn.length === 0 ? 'Sign in to an agent first.' : undefined
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
      <StepFooter previous={previous} hint={hint}>
        <form action={startChattingAction}>
          <Button type="submit" disabled={Boolean(hint)}>
            {projects.length === 0 ? 'Start without a project' : 'Start chatting'}
          </Button>
        </form>
      </StepFooter>
    </>
  )
}
