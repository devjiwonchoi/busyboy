import { useEffect, useRef, useState } from "react";

import { readBrowserHistoryBridge, useBrowserHistoryChanged } from "~/browser/browserHistory";

import {
  ADDRESS_BAR_FREQUENT_LIMIT,
  ADDRESS_BAR_SUGGEST_LIMIT,
  type AddressBarSuggestionData,
  EMPTY_ADDRESS_BAR_SUGGESTION_DATA,
} from "./addressBarSuggestions.logic";

/** Longest input the desktop app accepts for search suggestions. */
const REMOTE_SUGGESTION_MAX_INPUT = 512;

/**
 * Suggestion data for the address bar, straight from the desktop bridge.
 * Local history queries run on every keystroke (they are fast and local);
 * each request carries a sequence number so a slow reply never overwrites a
 * newer one. Search suggestions are requested only while `remoteEnabled`; the
 * desktop app debounces, cancels and times them out. Nothing here touches the
 * network itself.
 */
export function useAddressBarSuggestionData(input: {
  /** Null when there is no history to suggest from (incognito, server tabs, web build). */
  readonly profileId: string | null;
  readonly active: boolean;
  /** Trimmed text being typed, or "" in the zero state. */
  readonly text: string;
  readonly zeroStateEnabled: boolean;
  readonly remoteEnabled: boolean;
}): {
  readonly data: AddressBarSuggestionData;
  readonly removeUrl: (url: string) => void;
} {
  const { profileId, active, text, zeroStateEnabled, remoteEnabled } = input;
  const [data, setData] = useState<AddressBarSuggestionData>(EMPTY_ADDRESS_BAR_SUGGESTION_DATA);
  const [revision, setRevision] = useState(0);
  const suggestSequence = useRef(0);
  const remoteSequence = useRef(0);
  const frequentSequence = useRef(0);
  const bridge = profileId === null ? null : readBrowserHistoryBridge();
  const enabled = active && bridge !== null && profileId !== null;

  useBrowserHistoryChanged(enabled ? profileId : null, () => setRevision((value) => value + 1));

  // Each focus starts from a clean slate so another profile's or an old
  // session's rows never flash in.
  useEffect(() => {
    if (!active) setData(EMPTY_ADDRESS_BAR_SUGGESTION_DATA);
  }, [active]);

  useEffect(() => {
    if (!enabled || !bridge || profileId === null || !zeroStateEnabled) return;
    const sequence = ++frequentSequence.current;
    bridge
      .frequent({ profileId, limit: ADDRESS_BAR_FREQUENT_LIMIT })
      .then((frequent) => {
        if (sequence === frequentSequence.current) setData((current) => ({ ...current, frequent }));
      })
      .catch(() => {});
  }, [bridge, enabled, profileId, revision, zeroStateEnabled]);

  useEffect(() => {
    if (!enabled || !bridge || profileId === null || text.length === 0) return;
    const sequence = ++suggestSequence.current;
    bridge
      .suggest({ profileId, input: text, limit: ADDRESS_BAR_SUGGEST_LIMIT })
      .then((result) => {
        if (sequence !== suggestSequence.current) return;
        setData((current) => ({
          ...current,
          matchesFor: text,
          matches: result.matches,
          topOrigin: result.topOrigin,
        }));
      })
      .catch(() => {});
  }, [bridge, enabled, profileId, revision, text]);

  useEffect(() => {
    // Off means off: not a single request, so nothing typed leaves the device.
    if (!enabled || !bridge || profileId === null || !remoteEnabled) return;
    if (text.length === 0 || text.length > REMOTE_SUGGESTION_MAX_INPUT) return;
    const sequence = ++remoteSequence.current;
    bridge
      .remoteSuggestions({ profileId, input: text })
      .then((result) => {
        if (sequence !== remoteSequence.current) return;
        setData((current) => ({ ...current, remoteFor: text, remote: result.suggestions }));
      })
      .catch(() => {});
  }, [bridge, enabled, profileId, remoteEnabled, text]);

  const removeUrl = (url: string) => {
    if (!bridge || profileId === null) return;
    // Drop it from what's on screen right away; the change event refreshes the rest.
    setData((current) => ({
      ...current,
      matches: current.matches.filter((match) => match.url !== url),
      frequent: current.frequent.filter((entry) => entry.url !== url),
      topOrigin: current.topOrigin?.url === url ? null : current.topOrigin,
    }));
    void bridge.remove({ profileId, urls: [url] }).catch(() => {
      setRevision((value) => value + 1);
    });
  };

  return { data, removeUrl };
}
