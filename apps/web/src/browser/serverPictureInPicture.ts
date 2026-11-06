import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  type PreviewStreamClient,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { readPreviewStreamAccess } from "~/state/previewStream";

interface WebKitVideo {
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
}

interface ActivePictureInPicture {
  readonly key: string;
  readonly stop: () => void;
}

// Owns its stream outside React so the floating window survives panel unmounts.
let active: ActivePictureInPicture | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const serverPictureInPictureKey = (threadId: string, tabId: string) =>
  JSON.stringify([threadId, tabId]);

export function supportsServerPictureInPicture(): boolean {
  if (typeof document === "undefined") return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") return false;
  const video = HTMLVideoElement.prototype as HTMLVideoElement & WebKitVideo;
  return (
    (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") ||
    typeof video.webkitSetPresentationMode === "function"
  );
}

export function useServerPictureInPictureKey(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => active?.key ?? null,
    () => null,
  );
}

export function closeServerPictureInPicture(): void {
  const current = active;
  active = null;
  current?.stop();
  emit();
}

/** A hidden video fed by a canvas stream. Safari only floats a video that is in the document. */
interface PictureInPictureMedia {
  readonly canvas: HTMLCanvasElement;
  readonly stream: MediaStream;
  readonly video: HTMLVideoElement & WebKitVideo;
}

function createMedia(seed: HTMLCanvasElement | null): PictureInPictureMedia {
  const canvas = document.createElement("canvas");
  const stream = canvas.captureStream();
  const video = document.createElement("video") as HTMLVideoElement & WebKitVideo;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(video);
  drawSeed(canvas, seed);
  void video.play().catch(() => undefined);
  return { canvas, stream, video };
}

// The capture emits a frame per draw, so the seed is drawn after the capture starts.
function drawSeed(canvas: HTMLCanvasElement, seed: HTMLCanvasElement | null) {
  const usable = seed && seed.width > 0 && seed.height > 0 ? seed : null;
  const width = usable?.width ?? 640;
  const height = usable?.height ?? 400;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  if (usable) context?.drawImage(usable, 0, 0);
  else context?.fillRect(0, 0, width, height);
}

function disposeMedia(media: PictureInPictureMedia) {
  for (const track of media.stream.getTracks()) track.stop();
  media.video.srcObject = null;
  media.video.remove();
}

// iOS Safari refuses picture in picture unless it is requested inside the tap, and a
// video can only float once it has a frame. So a mounted player keeps one loaded video
// ready, and a tap floats it without awaiting anything first.
let prepared: PictureInPictureMedia | null = null;
let preparers = 0;

const replenish = () => {
  if (preparers > 0 && prepared === null) prepared = createMedia(null);
};

/** Keep a loaded video ready for the next tap. Returns the release function. */
export function prepareServerPictureInPicture(): () => void {
  if (!supportsServerPictureInPicture()) return () => undefined;
  preparers++;
  replenish();
  return () => {
    preparers--;
    if (preparers > 0 || prepared === null) return;
    disposeMedia(prepared);
    prepared = null;
  };
}

/** Start floating `video`. Call synchronously from the tap; the result may settle later. */
function requestFloat(video: HTMLVideoElement & WebKitVideo, onLeave: () => void): Promise<void> {
  const play = video.play();
  if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") {
    video.addEventListener("leavepictureinpicture", onLeave);
    return Promise.all([video.requestPictureInPicture(), play]).then(() => undefined);
  }
  const onPresentationMode = () => {
    if (video.webkitPresentationMode !== "picture-in-picture") onLeave();
  };
  video.addEventListener("webkitpresentationmodechanged", onPresentationMode);
  video.webkitSetPresentationMode?.("picture-in-picture");
  return play;
}

/** Open during user activation, seeding the video with the currently visible frame. */
export async function openServerPictureInPicture(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly tabId: string;
  readonly seed: HTMLCanvasElement | null;
}): Promise<void> {
  closeServerPictureInPicture();
  const ready =
    prepared !== null && prepared.video.readyState >= HTMLMediaElement.HAVE_METADATA
      ? prepared
      : null;
  if (ready) prepared = null;
  const media = ready ?? createMedia(input.seed);
  if (ready) drawSeed(media.canvas, input.seed);
  const { video } = media;

  const painter = createPreviewFramePainter(media.canvas);
  let client: PreviewStreamClient | null = null;
  let stopped = false;
  let refusals = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const onLeave = () => {
    if (active === current) closeServerPictureInPicture();
  };
  const connect = async (refresh: boolean) => {
    const access = await readPreviewStreamAccess(input.environmentId, refresh);
    if (stopped) return;
    if (!access) {
      closeServerPictureInPicture();
      return;
    }
    client = createPreviewStreamClient(
      {
        access,
        threadId: input.threadId,
        tabId: input.tabId,
        maxWidth: 1280,
        maxHeight: 1280,
        interactive: false,
      },
      {
        onFrame: (jpeg) => {
          refusals = 0;
          painter.paint(jpeg);
        },
        onViewport: () => undefined,
        onConnectedChange: () => undefined,
        onUnauthorized: () => {
          if (stopped) return;
          if (refusals >= 5) {
            onLeave();
            return;
          }
          retryTimer = setTimeout(() => void connect(true), 1_000 * 2 ** refusals++);
        },
        onGone: onLeave,
      },
    );
  };

  const current: ActivePictureInPicture = {
    key: serverPictureInPictureKey(input.threadId, input.tabId),
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      client?.stop();
      painter.stop();
      video.removeEventListener("leavepictureinpicture", onLeave);
      if (document.pictureInPictureElement === video) {
        void document.exitPictureInPicture().catch(() => undefined);
      } else if (video.webkitPresentationMode === "picture-in-picture") {
        video.webkitSetPresentationMode?.("inline");
      }
      disposeMedia(media);
      replenish();
    },
  };
  active = current;
  emit();

  try {
    if (ready) {
      await requestFloat(video, onLeave);
    } else {
      // Nothing was prepared (or it has no frame yet): wait for a frame. Browsers with a
      // longer activation window (Chrome, desktop Safari) still accept the late request.
      await video.play();
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise((resolve) =>
          video.addEventListener("loadedmetadata", resolve, { once: true }),
        );
      }
      await requestFloat(video, onLeave);
    }
  } catch (error) {
    onLeave();
    throw error;
  }
  if (active === current) void connect(false);
}
