import { connection } from "next/server";

import { dataFolder } from "@/server/config";
import { subscribeToChats, type ChatSummary } from "@/server/director/chat";

const HEARTBEAT_MS = 15_000;

export async function GET(request: Request) {
  await connection();
  const folder = await dataFolder();
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chats: ChatSummary[]) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chats)}\n\n`));
      };
      const unsubscribe = await subscribeToChats(folder, send);
      const heartbeat = setInterval(
        () => !closed && controller.enqueue(encoder.encode(": keep-alive\n\n")),
        HEARTBEAT_MS,
      );
      cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      if (request.signal.aborted) cleanup();
      request.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
