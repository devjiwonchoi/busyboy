"use client";

import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { messageImageUrl, type MessageImage } from "@/lib/chat-attachments";

function MessageImageButton({ image, chat }: { image: MessageImage; chat: string | null }) {
  const [missing, setMissing] = useState(false);
  const url = messageImageUrl(image, chat);
  if (missing) return <li className="text-muted-foreground text-xs">Image: {image.name}</li>;
  return (
    <li>
      <Dialog>
        <DialogTrigger
          aria-label={`Open image ${image.name}`}
          className="focus-visible:ring-ring/30 block overflow-hidden rounded-lg border outline-none focus-visible:ring-2"
        >
          {
            // oxlint-disable-next-line nextjs/no-img-element -- a saved attachment is not a next/image source
            <img
              src={url}
              alt={image.name}
              className="size-24 object-cover"
              onError={() => setMissing(true)}
            />
          }
        </DialogTrigger>
        <DialogContent size="lg" className="w-fit sm:max-w-[calc(100%-2rem)]">
          <DialogHeader>
            <DialogTitle className="truncate pr-8">{image.name}</DialogTitle>
          </DialogHeader>
          {
            // oxlint-disable-next-line nextjs/no-img-element -- a saved attachment is not a next/image source
            <img
              src={url}
              alt={image.name}
              className="max-h-[calc(100vh-8rem)] min-h-0 max-w-full self-center object-contain"
            />
          }
        </DialogContent>
      </Dialog>
    </li>
  );
}

export function MessageImages({ images, chat }: { images: MessageImage[]; chat: string | null }) {
  return (
    <ul aria-label="Images" className="flex flex-wrap justify-end gap-1">
      {images.map((image) => (
        <MessageImageButton key={image.file} image={image} chat={chat} />
      ))}
    </ul>
  );
}
