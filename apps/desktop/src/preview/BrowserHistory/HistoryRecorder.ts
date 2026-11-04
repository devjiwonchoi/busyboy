import type { BrowserHistoryTransition } from "@t3tools/contracts";

import type { NewVisit } from "./HistoryDatabase.ts";
import { isFragmentOnlyChange, normalizeHistoryUrl } from "./HistoryUrl.ts";

/** A hint stops applying if the navigation it was set for never started. */
export const NAVIGATION_HINT_TTL_MS = 5_000;

export type NavigationHint = Extract<
  BrowserHistoryTransition,
  "typed" | "suggestion" | "link" | "reload" | "back_forward"
>;

export interface AgentAttribution {
  readonly threadId: string | null;
}

export interface HistoryRecorderPort {
  readonly now: () => number;
  /** Non-null when an agent drove this guest within the attribution window. */
  readonly agentAttribution: () => AgentAttribution | null;
  readonly record: (visit: NewVisit) => void;
  readonly setTitle: (url: string, title: string) => void;
}

interface Attribution {
  readonly transition: BrowserHistoryTransition;
  readonly source: "user" | "agent";
  readonly threadId: string | null;
}

interface PendingVisit extends Attribution {
  readonly url: string;
  readonly visitedAt: number;
  title: string | null;
}

/**
 * Turns one guest's main-frame navigation events into history visits.
 *
 * A commit is held until the page stops loading, the next navigation starts,
 * or the guest goes away, so a load that fails after committing is never
 * recorded. Subframes, fragment-only changes, error pages and non-web URLs are
 * skipped.
 */
export class HistoryRecorder {
  private readonly port: HistoryRecorderPort;
  private hint: { readonly transition: NavigationHint; readonly at: number } | null = null;
  private started: Attribution | null = null;
  private failedUrl: string | null = null;
  private pending: PendingVisit | null = null;
  private lastCommittedUrl: string | null = null;
  private disposed = false;

  constructor(port: HistoryRecorderPort) {
    this.port = port;
  }

  /** Called just before BusyBoy itself starts a navigation (address bar, back, reload…). */
  setHint(transition: NavigationHint): void {
    this.hint = { transition, at: this.port.now() };
  }

  private takeAttribution(): Attribution {
    const hint = this.hint;
    this.hint = null;
    if (hint !== null && this.port.now() - hint.at <= NAVIGATION_HINT_TTL_MS) {
      return { transition: hint.transition, source: "user", threadId: null };
    }
    const agent = this.port.agentAttribution();
    if (agent !== null) return { transition: "agent", source: "agent", threadId: agent.threadId };
    return { transition: "link", source: "user", threadId: null };
  }

  startNavigation(input: {
    readonly url: string;
    readonly isMainFrame: boolean;
    readonly isSameDocument: boolean;
  }): void {
    if (this.disposed || !input.isMainFrame || input.isSameDocument) return;
    this.flush();
    this.failedUrl = null;
    this.started = this.takeAttribution();
  }

  /** `did-navigate`: the main frame committed a new document. */
  commit(input: { readonly url: string; readonly httpResponseCode: number }): void {
    if (this.disposed) return;
    this.flush();
    const attribution = this.started ?? this.takeAttribution();
    this.started = null;
    this.lastCommittedUrl = input.url;
    if (input.httpResponseCode >= 400) return;
    if (this.failedUrl !== null && this.failedUrl === input.url) return;
    if (normalizeHistoryUrl(input.url) === null) return;
    this.pending = { ...attribution, url: input.url, visitedAt: this.port.now(), title: null };
  }

  /** `did-navigate-in-page`: pushState/replaceState or a fragment change. */
  inPageNavigation(input: { readonly url: string; readonly isMainFrame: boolean }): void {
    if (this.disposed || !input.isMainFrame) return;
    const previous = this.lastCommittedUrl;
    this.lastCommittedUrl = input.url;
    if (previous !== null && isFragmentOnlyChange(previous, input.url)) return;
    if (normalizeHistoryUrl(input.url) === null) return;
    this.flush();
    const attribution = this.takeAttribution();
    this.port.record({ ...attribution, url: input.url, visitedAt: this.port.now() });
  }

  /** `did-fail-load` for the main frame drops the visit that load would have become. */
  failLoad(input: { readonly url: string; readonly isMainFrame: boolean }): void {
    if (this.disposed || !input.isMainFrame) return;
    this.failedUrl = input.url;
    if (this.pending !== null) this.pending = null;
  }

  stopLoading(): void {
    if (this.disposed) return;
    this.flush();
  }

  title(title: string): void {
    if (this.disposed) return;
    if (this.pending !== null) {
      this.pending.title = title;
      return;
    }
    if (this.lastCommittedUrl !== null) this.port.setTitle(this.lastCommittedUrl, title);
  }

  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
  }

  private flush(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    this.port.record({
      url: pending.url,
      title: pending.title,
      visitedAt: pending.visitedAt,
      transition: pending.transition,
      source: pending.source,
      threadId: pending.threadId,
    });
  }
}
