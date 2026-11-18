import { redirect } from "next/navigation";
import { Suspense } from "react";

import { DirectorChat } from "@/components/chat/director-chat";
import { isSetupComplete, readSettings } from "@/server/config";
import { requireTrustedRequest } from "@/server/trusted-request";

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
  await requireTrustedRequest();
  if (!isSetupComplete(await readSettings())) redirect("/setup");
  return <DirectorChat greeting="BusyBoy is ready. What should we work on?" />;
}
