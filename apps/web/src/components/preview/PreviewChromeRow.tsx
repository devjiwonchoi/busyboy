import type { BrowsingHistorySuggestion } from "@t3tools/contracts";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  MousePointerClick,
  PictureInPicture2,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { inlineHostCompletion } from "./addressBarCompletion";
import {
  ADDRESS_BAR_SUGGESTIONS_ID,
  AddressBarSuggestions,
  addressBarSuggestionId,
} from "./AddressBarSuggestions";

interface Props {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  refreshDisabled: boolean;
  inputDisabled?: boolean | undefined;
  focusUrlNonce?: number | undefined;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onSubmit: (url: string) => void;
  onOpenInBrowser?: (() => void) | undefined;
  onCapture?: ((record: boolean) => void) | undefined;
  captureDisabled?: boolean | undefined;
  recording?: boolean | undefined;
  onPictureInPicture?: (() => void) | undefined;
  pictureInPicture?: boolean | undefined;
  pictureInPictureDisabled?: boolean | undefined;
  onPickElement?: (() => void) | undefined;
  pickActive?: boolean | undefined;
  pickDisabled?: boolean | undefined;
  pickDisabledReason?: string | undefined;
  trailingActions?: ReactNode;
  leadingActions?: ReactNode;
  /** Visited pages for typed text; the address bar offers them as you type. */
  suggestHistory?:
    | ((text: string) => Promise<ReadonlyArray<BrowsingHistorySuggestion>>)
    | undefined;
}

const NOOP = () => {};

export function PreviewChromeRow({
  url,
  loading,
  canGoBack,
  canGoForward,
  refreshDisabled,
  inputDisabled,
  focusUrlNonce,
  onBack,
  onForward,
  onRefresh,
  onSubmit,
  onOpenInBrowser,
  onCapture,
  captureDisabled,
  recording,
  onPictureInPicture,
  pictureInPicture,
  pictureInPictureDisabled,
  onPickElement,
  pickActive,
  pickDisabled,
  pickDisabledReason,
  trailingActions,
  leadingActions,
  suggestHistory,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(url);
  const [inputFocused, setInputFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<ReadonlyArray<BrowsingHistorySuggestion>>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  // The selected tail shown after the typed text, as Chrome completes a host.
  const [completion, setCompletion] = useState("");
  // Each keystroke supersedes the lookups still in flight for earlier text.
  const suggestionRequest = useRef(0);

  // Selected, so typing on replaces the completion and Backspace removes it.
  useLayoutEffect(() => {
    if (completion !== "") {
      inputRef.current?.setSelectionRange(draft.length, draft.length + completion.length);
    }
  }, [draft, completion]);

  const closeSuggestions = () => {
    suggestionRequest.current += 1;
    setSuggestions([]);
    setActiveIndex(-1);
    setCompletion("");
  };

  const requestSuggestions = ({
    text,
    complete,
  }: {
    readonly text: string;
    readonly complete: boolean;
  }) => {
    const request = ++suggestionRequest.current;
    const query = text.trim();
    if (!suggestHistory || query === "") {
      setSuggestions([]);
      return;
    }
    void suggestHistory(query).then(
      (results) => {
        if (request !== suggestionRequest.current) {
          return;
        }
        setSuggestions(results);
        const top = results[0];
        setCompletion(
          complete && top ? (inlineHostCompletion({ typed: text, url: top.url }) ?? "") : "",
        );
      },
      () => {
        if (request === suggestionRequest.current) {
          setSuggestions([]);
        }
      },
    );
  };

  const choose = (next: string) => {
    closeSuggestions();
    onSubmit(next);
    inputRef.current?.blur();
  };

  useEffect(() => {
    if (focusUrlNonce == null) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
  }, [focusUrlNonce]);

  const submit = (event?: FormEvent | KeyboardEvent) => {
    event?.preventDefault();
    const next = `${draft}${completion}`.trim();
    if (next.length === 0) return;
    choose(next);
  };

  const suggestionsOpen = inputFocused && suggestions.length > 0;

  return (
    <div className="relative">
      <form
        onSubmit={submit}
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <div className="flex items-center gap-0.5" role="group" aria-label="Navigation">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoBack ? onBack : NOOP}
                  disabled={!canGoBack}
                  aria-label="Back"
                  type="button"
                />
              }
            >
              <ArrowLeft />
            </TooltipTrigger>
            <TooltipPopup>Back</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoForward ? onForward : NOOP}
                  disabled={!canGoForward}
                  aria-label="Forward"
                  type="button"
                />
              }
            >
              <ArrowRight />
            </TooltipTrigger>
            <TooltipPopup>Forward</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={refreshDisabled ? NOOP : onRefresh}
                  disabled={refreshDisabled}
                  aria-label={loading ? "Stop" : "Refresh"}
                  type="button"
                />
              }
            >
              <RefreshIcon refreshing={loading} />
            </TooltipTrigger>
            <TooltipPopup>{loading ? "Loading…" : "Refresh"}</TooltipPopup>
          </Tooltip>
        </div>

        {leadingActions}

        <div className="relative min-w-0 flex-1">
          <InputGroup variant="ghost" className="group/address h-7 w-full">
            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupInput
                    ref={inputRef}
                    value={inputFocused ? `${draft}${completion}` : url}
                    onChange={(event) => {
                      const text = event.target.value;
                      setDraft(text);
                      setCompletion("");
                      setActiveIndex(-1);
                      // Deleting must not bring back the completion just removed.
                      const inputType = (event.nativeEvent as InputEvent).inputType ?? "";
                      requestSuggestions({ text, complete: !inputType.startsWith("delete") });
                    }}
                    onFocus={() => {
                      setDraft(url);
                      setInputFocused(true);
                      queueMicrotask(() => inputRef.current?.select());
                    }}
                    onBlur={() => {
                      setInputFocused(false);
                      closeSuggestions();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        if (suggestions.length === 0) return;
                        event.preventDefault();
                        const step = event.key === "ArrowDown" ? 1 : -1;
                        setActiveIndex(
                          (current) => (current + step + suggestions.length) % suggestions.length,
                        );
                        return;
                      }
                      if (
                        (event.key === "ArrowRight" || event.key === "End") &&
                        completion !== ""
                      ) {
                        setDraft(`${draft}${completion}`);
                        setCompletion("");
                        return;
                      }
                      if (event.key === "Enter") {
                        const chosen = suggestions[activeIndex];
                        if (chosen) {
                          event.preventDefault();
                          choose(chosen.url);
                        } else {
                          submit(event);
                        }
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        if (suggestionsOpen || completion !== "") {
                          closeSuggestions();
                          return;
                        }
                        setDraft(url);
                        inputRef.current?.blur();
                      }
                    }}
                    role="combobox"
                    aria-autocomplete="both"
                    aria-expanded={suggestionsOpen}
                    aria-controls={suggestionsOpen ? ADDRESS_BAR_SUGGESTIONS_ID : undefined}
                    aria-activedescendant={
                      suggestionsOpen && activeIndex >= 0
                        ? addressBarSuggestionId(activeIndex)
                        : undefined
                    }
                    placeholder="Search or enter URL"
                    spellCheck={false}
                    disabled={inputDisabled}
                    data-preview-url-input
                    size="sm"
                  />
                }
              />
            </Tooltip>
            {onOpenInBrowser && !inputFocused ? (
              <InputGroupAddon align="inline-end">
                {}
                <span className="pointer-events-none flex opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/address:pointer-events-auto group-hover/address:opacity-100">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={onOpenInBrowser}
                          aria-label="Open in system browser"
                          type="button"
                        />
                      }
                    >
                      <ExternalLink />
                    </TooltipTrigger>
                    <TooltipPopup>Open in system browser</TooltipPopup>
                  </Tooltip>
                </span>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          {suggestionsOpen ? (
            <AddressBarSuggestions
              suggestions={suggestions}
              activeIndex={activeIndex}
              onChoose={choose}
            />
          ) : null}
        </div>

        {onPickElement ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={pickActive ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={onPickElement}
                  disabled={pickDisabled}
                  aria-label={pickActive ? "Cancel annotation" : "Annotate preview"}
                  aria-pressed={pickActive ? "true" : "false"}
                  type="button"
                />
              }
            >
              <MousePointerClick className={cn(pickActive && "text-primary")} />
            </TooltipTrigger>
            <TooltipPopup>
              {pickDisabled && pickDisabledReason
                ? pickDisabledReason
                : pickActive
                  ? "Cancel annotation (Esc)"
                  : "Annotate elements, regions, and drawings"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {onCapture ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={recording ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={(event) => onCapture(event.shiftKey)}
                  aria-label={recording ? "Stop recording" : "Capture screenshot"}
                  type="button"
                  className="relative"
                  disabled={captureDisabled}
                />
              }
            >
              <Camera className={cn(recording && "text-destructive")} />
              {recording ? (
                <span className="absolute right-0.5 top-0.5 size-1.5 animate-status-pulse rounded-full bg-destructive" />
              ) : null}
            </TooltipTrigger>
            <TooltipPopup>
              {recording ? "Stop recording" : "Screenshot · Shift-click to record"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {onPictureInPicture ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={pictureInPicture ? "secondary" : "ghost"}
                  size="icon-xs"
                  onClick={onPictureInPicture}
                  aria-label={
                    pictureInPicture ? "Close floating preview" : "Float preview over chat"
                  }
                  aria-pressed={pictureInPicture ? "true" : "false"}
                  type="button"
                  disabled={pictureInPictureDisabled}
                />
              }
            >
              <PictureInPicture2 className={cn(pictureInPicture && "text-primary")} />
            </TooltipTrigger>
            <TooltipPopup>
              {pictureInPicture ? "Close floating preview" : "Float preview over chat"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {trailingActions}
      </form>
      <div
        aria-hidden
        data-loading={loading}
        className="preview-loading-progress pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 w-full origin-left rounded-r-full bg-primary"
        style={{ boxShadow: "0 0 6px 1px var(--color-ring)" }}
      />
    </div>
  );
}
