import { connection } from "next/server";
import { Suspense } from "react";

import { DirectorChat } from "@/components/chat/director-chat";

export default function ChatPage() {
  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <Suspense>
        <Chat />
      </Suspense>
    </div>
  );
}

async function Chat() {
  await connection();
  return <DirectorChat greeting="BusyBoy is ready. What should we work on?" />;
}
