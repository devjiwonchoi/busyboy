import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  type BrowserRequestAnswerInput,
  type BrowserRequestHistoryVisit,
  type BrowserSignInOptions,
  type BrowserSignInOutcome,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CheckIcon,
  GlobeLockIcon,
  HistoryIcon,
  KeyRoundIcon,
  LockIcon,
  MinusIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { readBrowserHistoryBridge } from "~/browser/browserHistory";
import { readBrowserPasswordsBridge } from "~/browser/browserPasswords";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { useThreadPreviewState } from "~/previewStateStore";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { WorkLogRow } from "./WorkLog";

export type BrowserRequestItem = Extract<OrchestrationV2TurnItem, { type: "browser_request" }>;

const hostOf = (origin: string | undefined) => {
  if (!origin) return "this site";
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const OUTCOME_LABELS: Readonly<Record<BrowserRequestItem["browserStatus"], string>> = {
  pending: "Waiting",
  submitted: "Signed in",
  submitted_unconfirmed: "Submitted",
  filled: "Filled in",
  page_left_origin: "The page left the site",
  no_login_form: "No sign-in form on the page",
  unavailable: "Couldn't sign in",
  allowed: "Shared",
  declined: "Declined",
  cancelled: "Ended",
};

/** "jane@example.com" → "j…@e…", so the receipt doesn't repeat the login. */
export function abbreviateUsername(username: string): string {
  const [name = "", domain] = username.split("@");
  const short = (part: string) => (part.length <= 1 ? part : `${part[0]}…`);
  return domain === undefined ? short(name) : `${short(name)}@${short(domain)}`;
}

export function BrowserRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: BrowserRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const [receipt, setReceipt] = useState<string | null>(null);
  if (item.browserStatus !== "pending" || props.visibility !== "local") {
    const pendingElsewhere = item.browserStatus === "pending";
    const succeeded = ["submitted", "submitted_unconfirmed", "filled", "allowed"].includes(
      item.browserStatus,
    );
    const Icon = pendingElsewhere ? LockIcon : succeeded ? CheckIcon : MinusIcon;
    const subject =
      item.requestKind === "sign_in" ? `Sign in to ${hostOf(item.origin)}` : "Browsing history";
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {subject} ·{" "}
            {pendingElsewhere
              ? "Waiting for an answer in the original thread"
              : (receipt ?? OUTCOME_LABELS[item.browserStatus])}
          </>
        }
      />
    );
  }
  return item.requestKind === "sign_in" ? (
    <PendingSignIn environmentId={props.environmentId} item={item} onReceipt={setReceipt} />
  ) : (
    <PendingHistory environmentId={props.environmentId} item={item} />
  );
}

function useAnswer(environmentId: EnvironmentId) {
  const answer = useAtomCommand(serverEnvironment.answerBrowserRequest, {
    label: "answer browser request",
    reportFailure: false,
    reportDefect: false,
  });
  return async (input: BrowserRequestAnswerInput): Promise<string | null> => {
    const result = await answer({ environmentId, input });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
    const cause = squashAtomCommandFailure(result) as { readonly message?: unknown } | undefined;
    return typeof cause?.message === "string" ? cause.message : "Couldn't send the answer.";
  };
}

function PendingSignIn(props: {
  readonly environmentId: EnvironmentId;
  readonly item: BrowserRequestItem;
  readonly onReceipt: (receipt: string) => void;
}) {
  const { item } = props;
  const origin = item.origin ?? "";
  const host = hostOf(origin);
  const insecure =
    origin.startsWith("http:") && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(origin);
  const threadRef = scopeThreadRef(props.environmentId, item.threadId);
  const preview = useThreadPreviewState(threadRef);
  const runtimeTabId =
    item.tabId === undefined
      ? null
      : previewRuntimeTabId(threadRef, preview.serverEpoch, item.tabId);
  const autofill = readBrowserPasswordsBridge()?.autofill ?? null;
  const send = useAnswer(props.environmentId);
  const [options, setOptions] = useState<BrowserSignInOptions | null>(null);
  const [mode, setMode] = useState<"saved" | "enter">("saved");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const usernameId = useId();
  const passwordId = useId();

  useEffect(() => {
    if (!autofill || runtimeTabId === null) return;
    let cancelled = false;
    void autofill
      .signInOptions({ tabId: runtimeTabId, origin })
      .then((next) => {
        if (cancelled) return;
        setOptions(next);
        if (next.logins.length === 0) setMode("enter");
      })
      .catch(() => {
        if (!cancelled) setOptions({ available: false, logins: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [autofill, runtimeTabId, origin]);

  const finish = async (outcome: BrowserSignInOutcome, signedInAs?: string) => {
    const failure = await send({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "sign_in", outcome },
    });
    if (failure !== null) {
      setError(failure);
      return;
    }
    if (
      signedInAs !== undefined &&
      (outcome === "submitted" || outcome === "submitted_unconfirmed")
    ) {
      props.onReceipt(`Signed in as ${abbreviateUsername(signedInAs)}`);
    }
  };

  const run = async (
    choice:
      | { readonly kind: "saved"; readonly loginId: number; readonly username: string }
      | { readonly kind: "entered" },
  ) => {
    if (inFlight.current || !autofill || runtimeTabId === null) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await autofill.signIn({
        tabId: runtimeTabId,
        origin,
        choice:
          choice.kind === "saved"
            ? { kind: "saved", loginId: choice.loginId }
            : { kind: "entered", username, password, save },
      });
      const signedInAs = choice.kind === "saved" ? choice.username : username;
      // The typed password leaves this card as soon as main has it.
      setPassword("");
      await finish(result.outcome, signedInAs);
    } catch {
      setError("Couldn't reach the browser tab. Try again, or decline.");
    }
    inFlight.current = false;
    setBusy(false);
  };

  const decline = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    await finish("declined").finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (username.length === 0 || password.length === 0) return;
    void run({ kind: "entered" });
  };

  const available = autofill !== null && runtimeTabId !== null && options?.available === true;

  return (
    <form
      data-v2-item-type={item.type}
      aria-label={`Sign in to ${host}`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={onSubmit}
      autoComplete="off"
    >
      <div className="flex min-w-0 items-start gap-2">
        {insecure ? (
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        ) : (
          <GlobeLockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium text-foreground">
            The agent wants to sign in to <span className="font-semibold">{host}</span>
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {origin}
            {insecure ? " · not secure (http)" : ""}
          </p>
          {item.reason.trim() ? (
            <p className="text-sm text-muted-foreground">{item.reason}</p>
          ) : null}
        </div>
      </div>

      {!available ? (
        <p className="text-sm text-muted-foreground">
          {autofill === null
            ? "Answer this in the BusyBoy desktop app, where the browser tab is open."
            : options === null
              ? "Checking saved logins…"
              : "Signing in isn't available for this tab (it may be incognito or closed)."}
        </p>
      ) : (
        <>
          {options && options.logins.length > 0 ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Saved logins">
              {options.logins.map((login) => (
                <Button
                  key={login.loginId}
                  type="button"
                  variant={mode === "saved" ? "secondary" : "outline"}
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run({ kind: "saved", loginId: login.loginId, username: login.username })
                  }
                >
                  <KeyRoundIcon aria-hidden />
                  Use {login.username.length > 0 ? login.username : "saved login"}
                </Button>
              ))}
              {mode === "saved" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setMode("enter")}
                >
                  Enter details…
                </Button>
              ) : null}
            </div>
          ) : null}
          {mode === "enter" ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={usernameId} className="text-xs text-muted-foreground">
                Username
              </label>
              <Input
                id={usernameId}
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                value={username}
                disabled={busy}
                onChange={(event) => setUsername(event.currentTarget.value)}
              />
              <label htmlFor={passwordId} className="text-xs text-muted-foreground">
                Password
              </label>
              <Input
                id={passwordId}
                // Masked text rather than a password field, so nothing offers to save it here.
                type="text"
                className="[-webkit-text-security:disc]"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.currentTarget.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={save}
                  onCheckedChange={(checked) => setSave(checked === true)}
                  disabled={busy}
                />
                Save this login
              </label>
              <div>
                <Button
                  type="submit"
                  disabled={busy || username.length === 0 || password.length === 0}
                >
                  Sign in
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}

      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          The agent only learns whether sign-in worked, never the login.
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={busy}
          onClick={() => void decline()}
        >
          Decline
        </Button>
      </div>
    </form>
  );
}

function PendingHistory(props: {
  readonly environmentId: EnvironmentId;
  readonly item: BrowserRequestItem;
}) {
  const { item } = props;
  const send = useAnswer(props.environmentId);
  const browserDefaults = useBrowserDefaults();
  const history = readBrowserHistoryBridge();
  const preview = useThreadPreviewState(scopeThreadRef(props.environmentId, item.threadId));
  const tabProfileId =
    item.tabId === undefined ? undefined : preview.sessions[item.tabId]?.profileId;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // The tab's profile when the agent named a tab, else the user's default;
  // incognito keeps no history, so it falls back to the default profile.
  const wanted = tabProfileId ?? browserDefaults.profileId;
  const profileId = wanted === INCOGNITO_BROWSER_PROFILE_ID ? DEFAULT_BROWSER_PROFILE_ID : wanted;

  const allow = async () => {
    if (inFlight.current || history === null) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const page = await history.search({
        profileId,
        ...(item.query ? { query: item.query } : {}),
        limit: Math.min(item.historyLimit ?? 20, 50),
      });
      const visits: BrowserRequestHistoryVisit[] = page.visits
        .filter((visit) => item.historySince === undefined || visit.visitedAt >= item.historySince)
        .map((visit) => ({
          url: visit.url,
          title: visit.title,
          visitedAt: visit.visitedAt,
          source: visit.source,
        }));
      const failure = await send({
        threadId: item.threadId,
        turnItemId: item.id,
        answer: { type: "history", decision: "allow", visits },
      });
      if (failure !== null) setError(failure);
    } catch {
      setError("Couldn't read browsing history.");
    }
    inFlight.current = false;
    setBusy(false);
  };

  const deny = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const failure = await send({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "history", decision: "deny" },
    }).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
    if (failure !== null) setError(failure);
  };

  // With the setting on "allow", the desktop app shares without asking.
  const autoApprove = item.autoApprove === true && history !== null;
  const started = useRef(false);
  useEffect(() => {
    if (!autoApprove || started.current) return;
    started.current = true;
    void allow();
  });

  if (autoApprove) {
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<HistoryIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={<>Browsing history · Sharing…</>}
      />
    );
  }

  return (
    <div
      data-v2-item-type={item.type}
      role="group"
      aria-label="Browsing history request"
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 items-start gap-2">
        <HistoryIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium text-foreground">
            The agent wants to read your browsing history
          </p>
          {item.query ? (
            <p className="text-xs text-muted-foreground">Searching for “{item.query}”</p>
          ) : null}
          {item.reason.trim() ? (
            <p className="text-sm text-muted-foreground">{item.reason}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Up to {item.historyLimit ?? 20} pages from the in-app browser. Saved passwords are never
            shared.
          </p>
        </div>
      </div>
      {history === null ? (
        <p className="text-sm text-muted-foreground">
          Answer this in the BusyBoy desktop app, where your browsing history is kept.
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || history === null} onClick={() => void allow()}>
          Allow once
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void deny()}>
          Deny
        </Button>
      </div>
    </div>
  );
}
