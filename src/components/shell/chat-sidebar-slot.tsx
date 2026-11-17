import { userInfo } from "node:os";

import { connection } from "next/server";
import { Suspense } from "react";

import { directorPersona } from "@/server/companions";
import { listProjects } from "@/server/projects";
import { listRooms } from "@/server/rooms";

import { ChatSidebar } from "./chat-sidebar";

export function ChatSidebarSlot() {
  return (
    <Suspense>
      <ChatSidebarData />
    </Suspense>
  );
}

async function ChatSidebarData() {
  await connection();
  const [director, projects, rooms] = await Promise.all([
    directorPersona(),
    listProjects(),
    listRooms(),
  ]);
  return (
    <ChatSidebar
      director={director}
      projects={projects.map(({ name }) => name)}
      rooms={rooms}
      userName={userInfo().username.trim() || "You"}
    />
  );
}
