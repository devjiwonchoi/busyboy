import { type ReactNode } from "react";

import { Sheet, SheetPopup } from "./ui/sheet";

/**
 * On a phone the open right panel covers the screen and has its own controls, so fixed
 * chrome that would sit on top of it (the main sidebar toggle) hides while it is open.
 */
export const HIDDEN_UNDER_PHONE_RIGHT_PANEL =
  "max-sm:[body:has([data-right-panel-sheet][data-open])_&]:hidden";

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        transitionDurationMs={props.animationDurationMs}
        side="right"
        showCloseButton={false}
        keepMounted
        data-right-panel-sheet=""
        className="w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 max-sm:w-full max-sm:max-w-none max-sm:border-s-0 wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]"
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
