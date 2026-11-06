import { PlayIcon, RefreshCwIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

const actionClassName =
  "flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover disabled:opacity-64";

export interface CollapsedComposerSitrep {
  inProgress: boolean;
  disabled: boolean;
  onRequest: () => void;
}

/**
 * The round button at the end of the collapsed mobile composer row. In the PM
 * chat an empty prompt shows Sitrep instead of the disabled send arrow, since
 * the footer's Sitrep pill is hidden while the composer is collapsed.
 */
export function CollapsedComposerAction(props: {
  /** Set only where a Sitrep can replace the arrow (the PM chat, nothing running or resumable). */
  sitrep: CollapsedComposerSitrep | null;
  hasSendableContent: boolean;
  showResume: boolean;
  disabled: boolean;
  label: string;
  onPrimary: () => void;
}) {
  const stop = (event: ReactMouseEvent) => event.stopPropagation();
  const { sitrep } = props;
  if (sitrep && !props.hasSendableContent) {
    return (
      <button
        type="button"
        data-chat-composer-transition-actions="true"
        className={actionClassName}
        disabled={sitrep.disabled || sitrep.inProgress}
        aria-label={sitrep.inProgress ? "Sitrep in progress" : "Sitrep now"}
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          stop(event);
          sitrep.onRequest();
        }}
      >
        <RefreshCwIcon className="size-4" aria-hidden="true" />
      </button>
    );
  }
  return (
    <button
      type="button"
      data-chat-composer-transition-actions="true"
      className={actionClassName}
      disabled={props.disabled}
      aria-label={props.label}
      onPointerDown={(event) => event.preventDefault()}
      onClick={(event) => {
        stop(event);
        props.onPrimary();
      }}
    >
      {props.showResume ? (
        <PlayIcon className="size-4 fill-current" aria-hidden="true" />
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 3L8 13M8 3L4 7M8 3L12 7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
