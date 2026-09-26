"use client";

import { Pin, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ChannelView, PinnedMessageView } from "@/server/types";
import { MessageSurfaceCard } from "@/ui/MessageSurfaceCard";

export const ChannelPinsContext = createContext<PinnedMessageView[]>([]);

export function PinnedMessages({
  channel,
  channels,
}: {
  channel: ChannelView;
  channels: ChannelView[];
}) {
  const pins = useContext(ChannelPinsContext);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  return (
    <>
      <button
        aria-label={`Pinned messages (${pins.length})`}
        className="channel-pins-button"
        onClick={() => setOpen(true)}
        type="button"
      >
        <Pin aria-hidden="true" size={18} />
        <span>{pins.length}</span>
      </button>
      <dialog
        aria-labelledby="channel-pins-title"
        className="channel-pins-dialog"
        onClose={() => setOpen(false)}
        ref={dialog}
      >
        <header>
          <h2 id="channel-pins-title">Pinned messages</h2>
          <button
            aria-label="Close pinned messages"
            onClick={() => setOpen(false)}
            type="button"
          >
            <X aria-hidden="true" size={20} />
          </button>
        </header>
        {pins.length === 0 ? (
          <p>
            No pinned messages in this channel. Use a message’s actions to pin
            it.
          </p>
        ) : (
          pins.map((pin) => (
            <MessageSurfaceCard
              key={pin.message.id}
              author={pin.message.author}
              channels={channels}
              content={pin.message.content}
              createdAt={pin.message.createdAt}
              editedAt={pin.message.editedAt}
              reactions={pin.message.reactions}
              timeLabel={new Date(
                pin.message.createdAt * 1000,
              ).toLocaleDateString()}
              href={`/channels/${channel.id}?${new URLSearchParams({ thread: pin.threadId, message: pin.message.id })}`}
              onOpen={() => setOpen(false)}
              openLabel="Open pinned message"
            />
          ))
        )}
      </dialog>
    </>
  );
}
