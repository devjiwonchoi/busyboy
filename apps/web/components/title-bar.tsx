import type { CSSProperties, ReactNode } from "react";

import { AppName } from "./app-name";

const dragRegion = {
  paddingLeft: "var(--title-bar-inset, 0.75rem)",
  WebkitAppRegion: "drag",
} as CSSProperties;

const noDragRegion = { WebkitAppRegion: "no-drag" } as CSSProperties;

export function TitleBar({ children }: { children?: ReactNode }) {
  return (
    <header className="flex h-10 shrink-0 items-center border-b pr-2" style={dragRegion}>
      <span className="text-sm font-medium">
        <AppName />
      </span>
      {children ? (
        <div className="ml-auto flex items-center" style={noDragRegion}>
          {children}
        </div>
      ) : null}
    </header>
  );
}
