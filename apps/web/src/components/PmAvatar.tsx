import type { ProjectManagerPersona } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import {
  PROJECT_MANAGER_STATUS_LABEL,
  type ProjectManagerStatus,
} from "../state/projectTeam.logic";
import { ProjectIconGlyph } from "./ProjectFavicon";

const SIZE_CLASS = {
  sm: { avatar: "size-5", glyph: "size-3.5", dot: "size-2" },
  md: { avatar: "size-7", glyph: "size-4.5", dot: "size-2.5" },
  lg: { avatar: "size-9", glyph: "size-5", dot: "size-2.5" },
} as const;

const DOT_CLASS: Record<ProjectManagerStatus, string> = {
  working: "bg-success motion-safe:animate-pulse",
  "needs-you": "bg-warning",
  idle: "bg-muted-foreground/50",
};

/** The project manager's avatar with a dot for working, needs you or idle. */
export function PmAvatar(props: {
  persona: Pick<ProjectManagerPersona, "name" | "avatar">;
  status: ProjectManagerStatus;
  /** Message headers show the face only; the live status lives in the sidebar and header. */
  showStatus?: boolean;
  size?: keyof typeof SIZE_CLASS;
  className?: string;
}) {
  const size = SIZE_CLASS[props.size ?? "sm"];
  return (
    <span
      role="img"
      aria-label={
        props.showStatus === false
          ? props.persona.name
          : `${props.persona.name}, ${PROJECT_MANAGER_STATUS_LABEL[props.status]}`
      }
      data-status={props.status}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted",
        size.avatar,
        props.className,
      )}
    >
      <ProjectIconGlyph icon={props.persona.avatar} className={size.glyph} />
      {props.showStatus === false ? null : (
        <span
          aria-hidden
          className={cn(
            "absolute -right-px -bottom-px rounded-full ring-2 ring-background",
            size.dot,
            DOT_CLASS[props.status],
          )}
        />
      )}
    </span>
  );
}
