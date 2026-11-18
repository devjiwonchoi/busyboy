import { connection } from "next/server";
import { Suspense } from "react";

import { DirectorChat } from "@/components/chat/director-chat";
import { ensureHarnessSkills } from "@/server/link-skills";
import { listProjects } from "@/server/projects";

export default function ChatPage() {
  return (
    <Suspense>
      <Chat />
    </Suspense>
  );
}

async function Chat() {
  await connection();
  await ensureHarnessSkills();
  const projects = await listProjects();
  return (
    <DirectorChat
      projects={projects.map(({ name }) => name)}
      greeting="BusyBoy is ready. What should we work on?"
    />
  );
}
