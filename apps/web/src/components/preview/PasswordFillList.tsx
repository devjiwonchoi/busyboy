"use client";

import { useRouter } from "@tanstack/react-router";
import { KeyRound, Settings2 } from "lucide-react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";

import { readBrowserPasswordsBridge } from "~/browser/browserPasswords";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { usePasswordAutofillStore } from "~/browser/passwordAutofillStore";
import { cn } from "~/lib/utils";

import { PasswordSavePrompt } from "./PasswordSavePrompt";

const LIST_WIDTH = 260;

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * Saved logins for the focused field, drawn by BusyBoy over the page (never
 * inside it). Picking one asks main to run the device check and fill.
 */
export function PasswordFillList(props: {
  readonly tabId: string;
  readonly zoomFactor: number;
  readonly onManagePasswords: () => void;
}) {
  const { tabId, zoomFactor, onManagePasswords } = props;
  const list = usePasswordAutofillStore((state) => state.fillLists[tabId] ?? null);
  const content = useBrowserSurfaceStore((state) => state.byTabId[tabId]?.content ?? null);
  if (list === null) return null;

  const scale = zoomFactor * (content?.scale ?? 1);
  const left = list.rect.x * scale + (content?.x ?? 0) - (content?.scrollLeft ?? 0);
  const top =
    (list.rect.y + list.rect.height) * scale + (content?.y ?? 0) - (content?.scrollTop ?? 0) + 4;
  const autofill = readBrowserPasswordsBridge()?.autofill;

  const choose = (loginId: number) => {
    void autofill?.choose({ tabId, requestId: list.requestId, loginId }).catch(() => {});
  };

  return (
    <div
      role="listbox"
      aria-label={
        list.frameOrigin ? `Saved passwords for ${hostOf(list.frameOrigin)}` : "Saved passwords"
      }
      className="absolute z-30 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      style={{ left, top, width: LIST_WIDTH }}
      // Keep focus in the page so the field stays focused while choosing.
      onMouseDown={(event) => event.preventDefault()}
    >
      {list.frameOrigin ? (
        <p className="truncate px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
          For {hostOf(list.frameOrigin)}
        </p>
      ) : null}
      {list.rows.map((row, index) => (
        <button
          key={row.loginId}
          type="button"
          role="option"
          aria-selected={index === list.selectedIndex}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
            index === list.selectedIndex
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/60",
          )}
          onClick={() => choose(row.loginId)}
        >
          <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {row.username.length > 0 ? row.username : "(no username)"}
          </span>
        </button>
      ))}
      <div className="my-1 h-px bg-border" />
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/60"
        onClick={() => {
          void autofill?.dismissFillList({ tabId }).catch(() => {});
          onManagePasswords();
        }}
      >
        <Settings2 className="size-3.5 shrink-0" />
        Manage passwords…
      </button>
    </div>
  );
}

/**
 * The fill list and save prompt for one tab, with "Manage passwords…" opening Settings.
 *
 * The page itself is a native surface fixed above the panel, so the overlays
 * render in their own layer over the same rect, one level above that surface.
 */
export function PreviewPasswordOverlays(props: {
  readonly tabId: string;
  readonly zoomFactor: number;
}) {
  // Optional so the preview still renders where no router is mounted.
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  const surface = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[props.tabId];
      return { rect: current?.rect ?? null, zIndex: current?.zIndex ?? 0 };
    }),
  );
  const overlays = (
    <>
      <PasswordFillList
        tabId={props.tabId}
        zoomFactor={props.zoomFactor}
        onManagePasswords={() => void router?.navigate({ to: "/settings/integrations" })}
      />
      <PasswordSavePrompt tabId={props.tabId} />
    </>
  );
  if (surface.rect === null || typeof document === "undefined") return overlays;
  return createPortal(
    <div
      className="pointer-events-none fixed *:pointer-events-auto"
      style={{
        left: surface.rect.x,
        top: surface.rect.y,
        width: surface.rect.width,
        height: surface.rect.height,
        zIndex: surface.zIndex + 1,
      }}
      data-preview-password-overlays={props.tabId}
    >
      {overlays}
    </div>,
    document.body,
  );
}
