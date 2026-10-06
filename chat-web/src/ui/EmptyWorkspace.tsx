"use client";
import { useState } from "react";
import { ConversationDialog } from "@/ui/ConversationDialog";
export function EmptyWorkspace({ identity }: { identity: string }) {
  const [open, setOpen] = useState(false);
  return (
    <main className="centered-state">
      <div className="brand-mark brand-mark-large">B</div>
      <h1>No channels yet</h1>
      <p>Start a direct message, join a channel, or create one.</p>
      <button
        type="button"
        className="primary-button"
        onClick={() => setOpen(true)}
      >
        New conversation
      </button>
      {open ? (
        <ConversationDialog identity={identity} close={() => setOpen(false)} />
      ) : null}
    </main>
  );
}
