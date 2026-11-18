import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type CSSProperties } from "react";

import { CopyCommand } from "@/components/setup/copy-command";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldContent, FieldLabel, FieldTitle } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { isSetupComplete, readSettings } from "@/server/config";
import { defaultProvider, PROVIDERS, providerState } from "@/server/providers";
import type { SignInStatus } from "@/server/runner/contract";

import { finishSetupAction, recheckProvidersAction } from "./actions";

export const metadata: Metadata = { title: "Setup · BusyBoy" };

// why: The harness check reads local state, which Cache Components would otherwise prerender at build time.
export default function SetupPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      {/* why: macOS traffic lights sit in the title bar, and the drag region is not a token class. */}
      <header
        className="flex h-10 shrink-0 items-center border-b pr-2"
        style={
          {
            paddingLeft: "var(--title-bar-inset, 0.75rem)",
            WebkitAppRegion: "drag",
          } as CSSProperties
        }
      >
        <span className="text-sm font-medium">BusyBoy</span>
        <Suspense>
          <BackToChat />
        </Suspense>
      </header>
      <main aria-label="Setup" className="mx-auto w-full max-w-2xl flex-1 space-y-6 px-6 py-6">
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <HarnessStep />
        </Suspense>
      </main>
    </div>
  );
}

async function BackToChat() {
  await connection();
  if (!isSetupComplete(await readSettings())) return null;
  return (
    <Link
      href="/"
      className={buttonVariants({ variant: "ghost", size: "sm", className: "ml-auto" })}
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    >
      Back to chat
    </Link>
  );
}

const STATUS_TEXT: Record<SignInStatus["state"], string> = {
  "signed-in": "Signed in",
  "signed-out": "Signed out",
  "not-installed": "Not installed",
  unknown: "Could not check",
};

const HARNESS_FORM = "harness-form";

async function HarnessStep() {
  // why: Awaiting nothing else still lets Next prerender this part, which rejects the clock reads in providerState.
  await connection();
  const [states, current] = await Promise.all([
    Promise.all(
      PROVIDERS.map(async (provider) => ({ ...provider, state: await providerState(provider.id) })),
    ),
    defaultProvider(),
  ]);
  const signedIn = states.filter(({ state }) => state.state === "signed-in");
  return (
    <>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Sign in to an agent</h1>
        <p className="text-muted-foreground text-sm">
          BusyBoy uses the Claude Code, Codex, and Grok CLIs you already have. It never signs in for
          you.
        </p>
      </div>
      <ItemGroup aria-label="Agents">
        {states.map(({ id, name, state }) => (
          <Item key={id} role="listitem" variant="outline">
            <ItemContent>
              <ItemTitle>{name}</ItemTitle>
            </ItemContent>
            <ItemActions>
              <Badge variant="secondary">{STATUS_TEXT[state.state]}</Badge>
            </ItemActions>
            {state.state === "signed-out" && (
              <>
                {/* why: Setup is its own screen outside the app shell, so the terminal panel isn't here; the user copies the command. */}
                <ItemDescription className="basis-full">
                  Run this in a terminal, then choose Check again.
                </ItemDescription>
                <CopyCommand label={`${name} login command`} command={state.loginCommand} />
              </>
            )}
            {(state.state === "not-installed" || state.state === "unknown") && (
              <ItemDescription className="basis-full line-clamp-none">
                {state.detail}
              </ItemDescription>
            )}
          </Item>
        ))}
      </ItemGroup>
      <form action={recheckProvidersAction}>
        <Button type="submit" variant="outline" size="sm">
          Check again
        </Button>
      </form>
      {/* why: One form for the choice and Continue, so Continue saves the default agent. */}
      <form id={HARNESS_FORM} action={finishSetupAction} className="space-y-2">
        {signedIn.length > 1 && (
          <RadioGroup
            name="defaultProvider"
            aria-label="Default agent"
            defaultValue={current ?? undefined}
          >
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
      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-6">
        {signedIn.length === 0 && (
          <p className="text-muted-foreground text-sm">Sign in to an agent to continue.</p>
        )}
        <Button type="submit" form={HARNESS_FORM} disabled={signedIn.length === 0}>
          Continue
        </Button>
      </div>
    </>
  );
}
