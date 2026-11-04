import { type BrowserSearchEngine, DEFAULT_BROWSER_SEARCH_ENGINE } from "@t3tools/contracts";
import { resolveSearchEngine } from "@t3tools/shared/preview";

import { useClientSettings, useUpdatePrimarySettings } from "~/hooks/useSettings";

import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const SEARCH_ENGINE_LABELS: Readonly<Record<BrowserSearchEngine, string>> = {
  duckduckgo: "DuckDuckGo",
  google: "Google",
  bing: "Bing",
  brave: "Brave",
  custom: "Custom",
};

const SEARCH_ENGINES = Object.keys(SEARCH_ENGINE_LABELS) as ReadonlyArray<BrowserSearchEngine>;

function isSearchEngine(value: unknown): value is BrowserSearchEngine {
  return typeof value === "string" && value in SEARCH_ENGINE_LABELS;
}

/** A custom engine needs an http(s) URL with `%s` where the search text goes. */
export function isValidCustomSearchUrl(value: string): boolean {
  return resolveSearchEngine({ engine: "custom", customSearchUrl: value }).id === "custom";
}

/** Settings → Browser → Address bar: search engine and suggestions. */
export function BrowserAddressBarSettings({ disabled }: { readonly disabled: boolean }) {
  return (
    <>
      <BrowserSearchEngineSetting disabled={disabled} />
      <BrowserZeroStateSuggestionsSetting disabled={disabled} />
      <BrowserRemoteSearchSuggestionsSetting disabled={disabled} />
    </>
  );
}

function BrowserSearchEngineSetting({ disabled }: { readonly disabled: boolean }) {
  const engine = useClientSettings((settings) => settings.browserSearchEngine);
  const customSearchUrl = useClientSettings((settings) => settings.browserCustomSearchUrl);
  const updateSettings = useUpdatePrimarySettings();
  const customInvalid =
    engine === "custom" &&
    customSearchUrl.trim().length > 0 &&
    !isValidCustomSearchUrl(customSearchUrl);

  return (
    <SettingsRow
      {...searchableSetting("browser-search-engine")}
      description="What the address bar searches with when you type something that isn't a web address."
      resetAction={
        !disabled && engine !== DEFAULT_BROWSER_SEARCH_ENGINE ? (
          <SettingResetButton
            label="search engine"
            onClick={() => updateSettings({ browserSearchEngine: DEFAULT_BROWSER_SEARCH_ENGINE })}
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={engine}
          onValueChange={(value) => {
            if (isSearchEngine(value)) updateSettings({ browserSearchEngine: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Search engine">
            <SelectValue>{SEARCH_ENGINE_LABELS[engine]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {SEARCH_ENGINES.map((id) => (
              <SelectItem hideIndicator key={id} value={id}>
                {SEARCH_ENGINE_LABELS[id]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    >
      {engine === "custom" ? (
        <div className="mt-2 mb-1 flex flex-col gap-1.5">
          <DraftInput
            nativeInput
            size="sm"
            type="url"
            className="w-full"
            aria-label="Custom search URL"
            aria-invalid={customInvalid || undefined}
            aria-describedby="browser-custom-search-url-hint"
            placeholder="https://example.com/search?q=%s"
            spellCheck={false}
            disabled={disabled}
            value={customSearchUrl}
            onCommit={(next) => updateSettings({ browserCustomSearchUrl: next.trim() })}
          />
          <p
            id="browser-custom-search-url-hint"
            className={
              customInvalid
                ? "text-xs text-destructive-foreground"
                : "text-xs text-muted-foreground"
            }
            role={customInvalid ? "alert" : undefined}
          >
            {customInvalid
              ? "Enter an http:// or https:// URL that contains %s. Until then, DuckDuckGo is used."
              : "Put %s where the search text goes."}
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}

function BrowserZeroStateSuggestionsSetting({ disabled }: { readonly disabled: boolean }) {
  const enabled = useClientSettings((settings) => settings.browserZeroStateSuggestions);
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      {...searchableSetting("browser-zero-state-suggestions")}
      description="Show the sites you visit most when you click into the address bar."
      resetAction={
        !disabled && !enabled ? (
          <SettingResetButton
            label="suggest frequent sites"
            onClick={() => updateSettings({ browserZeroStateSuggestions: true })}
          />
        ) : null
      }
      control={
        <Switch
          disabled={disabled}
          checked={enabled}
          onCheckedChange={(checked) =>
            updateSettings({ browserZeroStateSuggestions: Boolean(checked) })
          }
          aria-label="Suggest frequent sites"
        />
      }
    />
  );
}

function BrowserRemoteSearchSuggestionsSetting({ disabled }: { readonly disabled: boolean }) {
  const enabled = useClientSettings((settings) => settings.browserRemoteSearchSuggestions);
  const engine = useClientSettings((settings) => settings.browserSearchEngine);
  const customSearchUrl = useClientSettings((settings) => settings.browserCustomSearchUrl);
  const updateSettings = useUpdatePrimarySettings();
  const resolved = resolveSearchEngine({ engine, customSearchUrl });
  const unsupported = resolved.suggestUrl === null;
  return (
    <SettingsRow
      {...searchableSetting("browser-remote-search-suggestions")}
      description={
        <>
          Show suggestions from {resolved.name} as you type in the address bar. When this is on,
          what you type is sent to {resolved.name}. Nothing is sent from incognito profiles.
          {unsupported ? ` ${resolved.name} doesn't offer suggestions.` : null}
        </>
      }
      resetAction={
        !disabled && enabled ? (
          <SettingResetButton
            label="search suggestions"
            onClick={() => updateSettings({ browserRemoteSearchSuggestions: false })}
          />
        ) : null
      }
      control={
        <Switch
          disabled={disabled}
          checked={enabled}
          onCheckedChange={(checked) =>
            updateSettings({ browserRemoteSearchSuggestions: Boolean(checked) })
          }
          aria-label="Search suggestions"
        />
      }
    />
  );
}
