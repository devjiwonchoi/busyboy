import { CloudIcon } from "lucide-react";

import { cn } from "~/lib/utils";

const CLOUD_TITLE = "Runs in a cloud sandbox";

/** Marks a task lead that runs in a cloud sandbox: a small pill, or just its icon in tight rows. */
export function CloudBadge(props: { variant?: "pill" | "icon"; className?: string }) {
  if (props.variant === "icon") {
    return (
      <CloudIcon
        role="img"
        aria-label={CLOUD_TITLE}
        data-cloud-badge="icon"
        className={cn("size-3 shrink-0 text-muted-foreground/65", props.className)}
      >
        <title>{CLOUD_TITLE}</title>
      </CloudIcon>
    );
  }
  return (
    <span
      title={CLOUD_TITLE}
      data-cloud-badge="pill"
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border/70 px-1.5 text-[11px] text-muted-foreground",
        props.className,
      )}
    >
      <CloudIcon aria-hidden className="size-3" />
      Cloud
    </span>
  );
}
