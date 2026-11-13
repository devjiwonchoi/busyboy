import { type ReactNode, useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

/** A dialog with a "Full screen" toggle that only changes its size, and a "Close" button. */
export function LargeDialog({
  open,
  onOpenChange,
  title,
  children,
  footer,
  name,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Marks the popup for tests and styling, such as "work" or "card". */
  name: string;
}) {
  const [fullScreen, setFullScreen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setFullScreen(false);
        onOpenChange(next);
      }}
    >
      <DialogPopup
        showCloseButton={false}
        bottomStickOnMobile={false}
        data-one-chat-dialog={name}
        data-full-screen={fullScreen ? "true" : "false"}
        className={cn(
          "flex flex-col",
          fullScreen
            ? "fixed inset-0 h-dvh max-h-none w-screen max-w-none rounded-none"
            : "max-h-[80vh] w-[min(42rem,calc(100vw-2rem))] max-w-none",
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
          <DialogTitle className="min-w-0 flex-1 truncate text-base">{title}</DialogTitle>
          <Button size="xs" variant="ghost" onClick={() => setFullScreen(!fullScreen)}>
            {fullScreen ? "Exit full screen" : "Full screen"}
          </Button>
          <Button size="xs" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? <div className="shrink-0 border-t px-4 py-3">{footer}</div> : null}
      </DialogPopup>
    </Dialog>
  );
}
