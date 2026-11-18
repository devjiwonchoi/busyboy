import { connection } from "next/server";
import { Suspense } from "react";

import { DirectorChat } from "@/components/chat/director-chat";

export default function ChatPage() {
  return (
    <Suspense>
      <Chat />
    </Suspense>
  );
}

async function Chat() {
  await connection();
  return <DirectorChat greeting="BusyBoy is ready. What should we work on?" />;
}
