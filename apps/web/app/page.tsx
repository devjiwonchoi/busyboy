import { redirect } from "next/navigation";
import { Suspense } from "react";

import { isSetupComplete, readSettings } from "@/server/config";
import { requireTrustedRequest } from "@/server/trusted-request";

import { Composer } from "./composer";
import { DirectorProvider } from "./director-provider";
import { Transcript } from "./transcript";

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
  return (
    <>
      <header className="flex h-10 shrink-0 items-center border-b px-3 text-sm font-medium">
        BusyBoy
      </header>
      <DirectorProvider>
        <Transcript
          empty={
            <p className="text-muted-foreground text-sm">
              BusyBoy is ready. What should we work on?
            </p>
          }
        />
        <Composer />
      </DirectorProvider>
    </>
  );
}
