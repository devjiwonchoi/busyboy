"use client";

import { Eye, EyeOff, KeyRound, X } from "lucide-react";
import { useEffect, useState } from "react";

import { readBrowserPasswordsBridge } from "~/browser/browserPasswords";
import { usePasswordAutofillStore } from "~/browser/passwordAutofillStore";

import { Button } from "../ui/button";
import { Input } from "../ui/input";

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * Offers to save (or update) the login just used, in a small panel under the
 * address bar. The password stays in main; peeking fetches it on demand and
 * needs no device check, since the person just typed it.
 */
export function PasswordSavePrompt(props: { readonly tabId: string }) {
  const { tabId } = props;
  const prompt = usePasswordAutofillStore((state) => state.prompts[tabId] ?? null);
  const [username, setUsername] = useState("");
  const [peeked, setPeeked] = useState<string | null>(null);
  const promptId = prompt?.promptId ?? null;
  const initialUsername = prompt?.username ?? "";

  useEffect(() => {
    setUsername(initialUsername);
    setPeeked(null);
  }, [promptId, initialUsername]);

  if (prompt === null || prompt.collapsed) return null;
  const autofill = readBrowserPasswordsBridge()?.autofill;
  const respond = (action: "save" | "notNow" | "never") => {
    setPeeked(null);
    void autofill
      ?.respondToPrompt({
        tabId,
        promptId: prompt.promptId,
        action,
        ...(action === "save" ? { username } : {}),
      })
      .catch(() => {});
  };
  const togglePeek = () => {
    if (peeked !== null) {
      setPeeked(null);
      return;
    }
    void autofill
      ?.peek({ tabId, promptId: prompt.promptId })
      .then((result) => setPeeked(result.password))
      .catch(() => {});
  };
  const title = prompt.mode === "update" ? "Update saved password?" : "Save password?";

  return (
    <section
      role="dialog"
      aria-label={title}
      className="absolute top-2 right-2 z-30 w-80 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {prompt.frameOrigin
              ? `For ${hostOf(prompt.origin)}, signed in from a frame on this page`
              : hostOf(prompt.origin)}
          </p>
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={() => respond("notNow")}>
          <X />
        </Button>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Username
          <Input
            size="sm"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={prompt.mode === "update"}
            spellCheck={false}
          />
        </label>
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span id={`password-prompt-${prompt.promptId}`}>Password</span>
          <div className="flex items-center gap-1">
            <output
              aria-labelledby={`password-prompt-${prompt.promptId}`}
              className="min-w-0 flex-1 truncate rounded-md border border-input px-2 py-1 font-mono text-sm text-foreground"
            >
              {peeked ?? "••••••••"}
            </output>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={peeked === null ? "Show password" : "Hide password"}
              aria-pressed={peeked !== null}
              onClick={togglePeek}
            >
              {peeked === null ? <Eye /> : <EyeOff />}
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {prompt.mode === "save" ? (
          <Button variant="ghost" size="sm" onClick={() => respond("never")}>
            Never for this site
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => respond("notNow")}>
          Not now
        </Button>
        <Button size="sm" onClick={() => respond("save")}>
          {prompt.mode === "update" ? "Update" : "Save"}
        </Button>
      </div>
    </section>
  );
}

/** The address bar key icon that brings a folded prompt back. */
export function PasswordPromptKeyButton(props: { readonly tabId: string }) {
  const collapsed = usePasswordAutofillStore(
    (state) => state.prompts[props.tabId]?.collapsed === true,
  );
  if (!collapsed) return null;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Saved password prompt"
      onClick={() =>
        void readBrowserPasswordsBridge()
          ?.autofill.reopenPrompt({ tabId: props.tabId })
          .catch(() => {})
      }
    >
      <KeyRound />
    </Button>
  );
}
