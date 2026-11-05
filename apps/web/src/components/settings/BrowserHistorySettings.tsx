import {
  BROWSER_HISTORY_SEARCH_MAX_LIMIT,
  BrowserHistoryClearDataType,
  BrowserHistoryClearRange,
  type BrowserHistoryCursor,
  type BrowserHistorySourceFilter,
  type BrowserHistoryVisit,
  type DesktopBrowserHistoryBridge,
} from "@t3tools/contracts";
import { Globe, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useBrowserDefaults } from "~/browser/browserDefaults";
import {
  readBrowserHistoryBridge,
  useBrowserHistoryChanged,
  useBrowserHistoryStatus,
} from "~/browser/browserHistory";
import { useCachedFaviconForUrl } from "~/browserFaviconStore";
import { FaviconImage } from "~/components/preview/PreviewFaviconIcon";
import { useClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "~/localApi";
import { useEnvironments } from "~/state/environments";
import { useDebouncedValue } from "~/state/queries";
import { formatShortTimestamp } from "~/timestampFormat";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  BROWSER_HISTORY_CLEAR_DATA_TYPE_LABELS,
  BROWSER_HISTORY_CLEAR_RANGE_LABELS,
  clearsSomeDataForAllTime,
  groupVisitsByDay,
  visitHost,
} from "./BrowserHistorySettings.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;
const DELETION_LOCKED_MESSAGE = "Your organization doesn't allow deleting browsing history.";

const SOURCE_FILTER_LABELS: Readonly<Record<BrowserHistorySourceFilter, string>> = {
  all: "All",
  user: "You",
  agent: "Agent",
};

/** Hidden outside the desktop app, where there is no browsing history. */
export function BrowserHistorySetting() {
  const bridge = readBrowserHistoryBridge();
  return bridge ? <BrowserHistoryPane bridge={bridge} /> : null;
}

function LockedTooltip(props: { readonly locked: boolean; readonly children: ReactNode }) {
  if (!props.locked) return props.children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{props.children}</TooltipTrigger>
      <TooltipPopup>{DELETION_LOCKED_MESSAGE}</TooltipPopup>
    </Tooltip>
  );
}

function BrowserHistoryPane({ bridge }: { readonly bridge: DesktopBrowserHistoryBridge }) {
  const browserDefaults = useBrowserDefaults();
  const persistentProfiles = browserDefaults.profiles.filter(
    (profile) => profile.kind === "persistent",
  );
  const [selectedProfileId, setSelectedProfileId] = useState(browserDefaults.profileId);
  const profileId = persistentProfiles.some((profile) => profile.id === selectedProfileId)
    ? selectedProfileId
    : browserDefaults.profileId;
  const profileName =
    persistentProfiles.find((profile) => profile.id === profileId)?.name ?? "Default";

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const [source, setSource] = useState<BrowserHistorySourceFilter>("all");
  const [visits, setVisits] = useState<ReadonlyArray<BrowserHistoryVisit>>([]);
  const [nextCursor, setNextCursor] = useState<BrowserHistoryCursor | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revision, setRevision] = useState(0);
  const [clearOpen, setClearOpen] = useState(false);
  const status = useBrowserHistoryStatus(profileId);
  const locked = status.deletionLocked;
  const loadedCountRef = useRef(0);
  const fetchedFilterKeyRef = useRef<string | null>(null);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);

  useBrowserHistoryChanged(profileId, () => setRevision((current) => current + 1));

  const filterKey = `${profileId}\0${source}\0${debouncedQuery}`;
  const filterKeyRef = useRef(filterKey);
  filterKeyRef.current = filterKey;

  useEffect(() => {
    let cancelled = false;
    // A refresh keeps what's already on screen; a new filter starts over.
    const refresh = fetchedFilterKeyRef.current === filterKey;
    fetchedFilterKeyRef.current = filterKey;
    const limit = refresh
      ? Math.min(Math.max(loadedCountRef.current, PAGE_SIZE), BROWSER_HISTORY_SEARCH_MAX_LIMIT)
      : PAGE_SIZE;
    bridge
      .search({
        profileId,
        source,
        limit,
        ...(debouncedQuery.length > 0 ? { query: debouncedQuery } : {}),
      })
      .then((result) => {
        if (cancelled) return;
        loadedCountRef.current = result.visits.length;
        setVisits(result.visits);
        setNextCursor(result.nextCursor);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setVisits([]);
        setNextCursor(null);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, debouncedQuery, filterKey, profileId, revision, source]);

  const loadMore = () => {
    if (!nextCursor || loadingMore) return;
    const requestedFor = filterKey;
    setLoadingMore(true);
    void bridge
      .search({
        profileId,
        source,
        limit: PAGE_SIZE,
        before: nextCursor,
        ...(debouncedQuery.length > 0 ? { query: debouncedQuery } : {}),
      })
      .then((result) => {
        if (filterKeyRef.current !== requestedFor) return;
        setVisits((current) => {
          const next = [...current, ...result.visits];
          loadedCountRef.current = next.length;
          return next;
        });
        setNextCursor(result.nextCursor);
      })
      .catch(() => {
        toastManager.add({ type: "error", title: "Could not load more history" });
      })
      .finally(() => setLoadingMore(false));
  };

  const removeVisit = (visit: BrowserHistoryVisit) => {
    if (locked) return;
    setVisits((current) => current.filter((candidate) => candidate.id !== visit.id));
    void bridge.remove({ profileId, visitIds: [visit.id] }).catch(() => {
      toastManager.add({ type: "error", title: "Could not remove page from history" });
      setRevision((current) => current + 1);
    });
  };

  const groups = groupVisitsByDay(visits);

  return (
    <SettingsRow
      {...searchableSetting("browser-history")}
      description="Pages you and agents visited in the in-app browser. Kept for 90 days on this device."
      control={
        <LockedTooltip locked={locked}>
          <Button size="sm" variant="outline" disabled={locked} onClick={() => setClearOpen(true)}>
            Clear browsing data…
          </Button>
        </LockedTooltip>
      }
    >
      <div className="mt-2 mb-2 flex flex-col gap-2">
        {!status.available ? (
          <p
            role="status"
            className="rounded-lg border border-warning/32 bg-warning/8 px-3 py-2 text-xs text-warning-foreground"
          >
            History for this profile couldn&rsquo;t be opened. You can keep browsing, but new visits
            aren&rsquo;t saved.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {persistentProfiles.length > 1 ? (
            <Select
              value={profileId}
              onValueChange={(value) => {
                if (typeof value === "string") setSelectedProfileId(value);
              }}
            >
              <SelectTrigger size="sm" className="w-40" aria-label="History profile">
                <SelectValue>{profileName}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {persistentProfiles.map((profile) => (
                  <SelectItem hideIndicator key={profile.id} value={profile.id}>
                    {profile.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
          <div className="relative min-w-40 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              nativeInput
              size="sm"
              type="search"
              className="[&_input]:pl-7.5"
              aria-label="Search history"
              placeholder="Search history"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <ToggleGroup
            aria-label="Visited by"
            variant="segmented"
            value={[source]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "all" || next === "user" || next === "agent") setSource(next);
            }}
          >
            {(Object.keys(SOURCE_FILTER_LABELS) as ReadonlyArray<BrowserHistorySourceFilter>).map(
              (filter) => (
                <Toggle key={filter} value={filter}>
                  {SOURCE_FILTER_LABELS[filter]}
                </Toggle>
              ),
            )}
          </ToggleGroup>
        </div>
        <div className="overflow-hidden rounded-lg border border-border/60">
          {!loaded ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">Loading history…</p>
          ) : groups.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              {debouncedQuery.length > 0 || source !== "all"
                ? "No pages match."
                : "Pages you open in the in-app browser show up here."}
            </p>
          ) : (
            <div role="list" aria-label="Browsing history" className="max-h-96 overflow-y-auto">
              {groups.map((group) => (
                <div key={group.key} role="presentation">
                  <h3 className="sticky top-0 z-10 border-b border-border/60 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </h3>
                  {group.visits.map((visit) => (
                    <HistoryRow
                      key={visit.id}
                      visit={visit}
                      time={formatShortTimestamp(
                        new Date(visit.visitedAt).toISOString(),
                        timestampFormat,
                      )}
                      locked={locked}
                      onRemove={() => removeVisit(visit)}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        {nextCursor ? (
          <div>
            <Button size="sm" variant="ghost" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </div>
      <ClearBrowsingDataDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        bridge={bridge}
        profileId={profileId}
        profileName={profileName}
      />
    </SettingsRow>
  );
}

function HistoryRow(props: {
  readonly visit: BrowserHistoryVisit;
  readonly time: string;
  readonly locked: boolean;
  readonly onRemove: () => void;
}) {
  const { visit } = props;
  const favicon = useCachedFaviconForUrl(visit.url);
  const host = visitHost(visit.url);
  const label = visit.title ?? host;
  const openInBrowser = () => {
    const api = readLocalApi();
    void api?.shell.openExternal(visit.url).catch(() => {
      toastManager.add({ type: "error", title: "Could not open page" });
    });
  };
  return (
    <div
      role="listitem"
      className="group relative flex items-center border-b border-border/60 last:border-b-0"
    >
      <button
        type="button"
        onClick={openInBrowser}
        title={visit.url}
        aria-label={`Open ${label} in browser`}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 pr-10 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <FaviconImage
          sources={[favicon]}
          fallback={<Globe aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
          className="size-4 shrink-0 rounded-sm object-contain"
        />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>
        {visit.source === "agent" ? <Badge variant="info">Agent</Badge> : null}
        <span className="hidden max-w-40 shrink-0 truncate text-xs text-muted-foreground sm:inline">
          {host}
        </span>
        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          {props.time}
        </span>
      </button>
      <LockedTooltip locked={props.locked}>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Remove ${label} from history`}
          disabled={props.locked}
          onClick={props.onRemove}
          className="absolute right-2 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X />
        </Button>
      </LockedTooltip>
    </div>
  );
}

function ClearBrowsingDataDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly bridge: DesktopBrowserHistoryBridge;
  readonly profileId: string;
  readonly profileName: string;
}) {
  const { environments } = useEnvironments();
  const [range, setRange] = useState<BrowserHistoryClearRange>("hour");
  const [dataTypes, setDataTypes] = useState<ReadonlyArray<BrowserHistoryClearDataType>>([
    "history",
  ]);
  const [clearing, setClearing] = useState(false);

  const toggle = (type: BrowserHistoryClearDataType, checked: boolean) =>
    setDataTypes((current) =>
      checked ? [...new Set([...current, type])] : current.filter((value) => value !== type),
    );

  const clear = async () => {
    if (dataTypes.length === 0 || clearing) return;
    setClearing(true);
    try {
      await props.bridge.clear({
        profileId: props.profileId,
        range,
        dataTypes,
        environmentIds: environments.map((environment) => environment.environmentId),
      });
      toastManager.add({ type: "success", title: "Browsing data cleared" });
      props.onOpenChange(false);
    } catch {
      toastManager.add({ type: "error", title: "Could not clear browsing data" });
    } finally {
      setClearing(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => !clearing && props.onOpenChange(open)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Clear browsing data</DialogTitle>
          <DialogDescription>From the “{props.profileName}” profile.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <Select
            value={range}
            onValueChange={(value) => {
              const next = BrowserHistoryClearRange.literals.find((literal) => literal === value);
              if (next) setRange(next);
            }}
          >
            <SelectTrigger size="sm" aria-label="Time range">
              <SelectValue>{BROWSER_HISTORY_CLEAR_RANGE_LABELS[range]}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {BrowserHistoryClearRange.literals.map((literal) => (
                <SelectItem hideIndicator key={literal} value={literal}>
                  {BROWSER_HISTORY_CLEAR_RANGE_LABELS[literal]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <div className="grid gap-2">
            {BrowserHistoryClearDataType.literals.map((type) => (
              <label key={type} className="flex cursor-pointer items-center gap-2.5 text-sm">
                <Checkbox
                  checked={dataTypes.includes(type)}
                  onCheckedChange={(checked) => toggle(type, checked === true)}
                />
                {BROWSER_HISTORY_CLEAR_DATA_TYPE_LABELS[type]}
              </label>
            ))}
          </div>
          <div className="grid gap-1 text-xs text-muted-foreground">
            {clearsSomeDataForAllTime(range, dataTypes) ? (
              <p>Cookies, site data and cached files are cleared for all time.</p>
            ) : null}
            <p>Saved passwords are managed in Passwords.</p>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={clearing} onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={clearing || dataTypes.length === 0}
            onClick={() => void clear()}
          >
            {clearing ? "Clearing…" : "Clear"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
