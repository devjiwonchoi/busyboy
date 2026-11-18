import { Chat } from "./chat";

export default function ChatPage() {
  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center border-b px-3 text-sm font-medium">
        BusyBoy
      </header>
      <Chat />
    </div>
  );
}
