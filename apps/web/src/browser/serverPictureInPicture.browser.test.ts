import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The stream connects only after the window floats; keep it pending so nothing else runs.
vi.mock("~/state/previewStream", () => ({
  readPreviewStreamAccess: () => new Promise(() => undefined),
}));

import {
  closeServerPictureInPicture,
  openServerPictureInPicture,
  prepareServerPictureInPicture,
} from "./serverPictureInPicture";

type WebKitPrototype = HTMLVideoElement & { webkitSetPresentationMode?: (mode: string) => void };

const input = {
  environmentId: EnvironmentId.make("env"),
  threadId: "thread",
  tabId: "tab",
  seed: null,
};

const preparedVideoLoaded = () =>
  vi.waitFor(() => {
    const video = document.querySelector("video");
    expect(video?.readyState ?? 0).toBeGreaterThanOrEqual(HTMLMediaElement.HAVE_METADATA);
  });

const releases: Array<() => void> = [];
afterEach(() => {
  closeServerPictureInPicture();
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  delete (HTMLVideoElement.prototype as WebKitPrototype).webkitSetPresentationMode;
});

describe("server picture in picture on a tap", () => {
  it("floats the prepared video before awaiting anything", async () => {
    const request = vi
      .spyOn(HTMLVideoElement.prototype, "requestPictureInPicture")
      .mockResolvedValue({} as PictureInPictureWindow);
    releases.push(prepareServerPictureInPicture());
    await preparedVideoLoaded();

    void openServerPictureInPicture(input);

    // Still inside the same task as the tap: iOS Safari would refuse anything later.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uses WebKit's presentation mode in the same tap when the standard API is off", async () => {
    vi.spyOn(document, "pictureInPictureEnabled", "get").mockReturnValue(false);
    const setMode = vi.fn();
    (HTMLVideoElement.prototype as WebKitPrototype).webkitSetPresentationMode = setMode;
    releases.push(prepareServerPictureInPicture());
    await preparedVideoLoaded();

    void openServerPictureInPicture(input);

    expect(setMode).toHaveBeenCalledWith("picture-in-picture");
  });

  it("prepares a fresh video after the window closes, for the next tap", async () => {
    vi.spyOn(HTMLVideoElement.prototype, "requestPictureInPicture").mockResolvedValue(
      {} as PictureInPictureWindow,
    );
    releases.push(prepareServerPictureInPicture());
    await preparedVideoLoaded();
    await openServerPictureInPicture(input);
    expect(document.querySelectorAll("video")).toHaveLength(1);

    closeServerPictureInPicture();

    expect(document.querySelectorAll("video")).toHaveLength(1);
    await preparedVideoLoaded();
  });

  it("removes the prepared video when the last player lets go", () => {
    const release = prepareServerPictureInPicture();
    expect(document.querySelectorAll("video")).toHaveLength(1);

    release();

    expect(document.querySelectorAll("video")).toHaveLength(0);
  });
});
