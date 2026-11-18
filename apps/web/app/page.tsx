import { redirect } from "next/navigation";
import { Suspense } from "react";

import { isSetupIncomplete } from "@/server/config";
import { requireTrustedRequest } from "@/server/trusted-request";

import { Chat } from "./chat";

export default function ChatPage() {
  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <Suspense>
        <TrustedChat />
      </Suspense>
    </div>
  );
}

async function TrustedChat() {
  await requireTrustedRequest();
  if (await isSetupIncomplete()) redirect("/setup");
  return (
    <>
      <header className="flex h-10 shrink-0 items-center border-b px-3 text-sm font-medium">
        BusyBoy
      </header>
      <Chat />
    </>
  );
}
