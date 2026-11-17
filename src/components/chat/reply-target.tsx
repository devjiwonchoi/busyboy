"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function ReplyTarget({
  mode,
  target,
  directorName,
  onClear,
}: {
  mode: "reply" | "message";
  target: string;
  directorName: string;
  onClear: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Badge variant="outline" className="min-w-0 truncate">
        {mode === "reply" ? "Replying to" : "Messaging"} {target}
      </Badge>
      <Button type="button" size="xs" variant="ghost" onClick={onClear}>
        Message {directorName} instead
      </Button>
    </div>
  );
}
