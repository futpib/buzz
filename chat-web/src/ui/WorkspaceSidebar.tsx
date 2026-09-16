"use client";

import {
  Bell,
  ChevronDown,
  Hash,
  Inbox,
  LockKeyhole,
  LogOut,
  MessageSquareText,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { forgetCredential } from "@/client/identity";
import type { ChannelView, ProfileView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { ViewLink } from "@/ui/ViewLink";

export function WorkspaceSidebar({
  activePage,
  channels,
  close,
  identity,
  selectedId,
}: {
  activePage: "channel" | "threads";
  channels: ChannelView[];
  close: () => void;
  identity: ProfileView;
  selectedId: string | null;
}) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const channelGroups = useMemo(() => {
    const active = channels.filter((channel) => !channel.archived);
    return {
      streams: active.filter((channel) => channel.type === "stream"),
      forums: active.filter((channel) => channel.type === "forum"),
      dms: active.filter((channel) => channel.type === "dm"),
    };
  }, [channels]);

  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok && response.status !== 401) {
        throw new Error("Sign out failed. Try again.");
      }
      await forgetCredential();
      window.location.assign("/login");
    } catch (caught) {
      setLogoutError(
        caught instanceof Error
          ? caught.message
          : "Sign out failed. Try again.",
      );
      setLoggingOut(false);
    }
  };

  return (
    <aside className="sidebar" id="channel-navigation">
      <div className="workspace-switcher">
        <span className="brand-mark">B</span>
        <span className="workspace-name">Buzz</span>
        <ChevronDown aria-hidden="true" size={15} />
        <button
          aria-label="Close channel navigation"
          className="sidebar-close-button"
          onClick={close}
          type="button"
        >
          <X aria-hidden="true" size={20} />
        </button>
      </div>
      <nav className="primary-nav" aria-label="Workspace">
        <button disabled title="Inbox is not available yet" type="button">
          <Inbox aria-hidden="true" size={18} /> Inbox
        </button>
        <ViewLink
          className={
            activePage === "threads" ? "primary-nav-active" : undefined
          }
          href="/threads"
          onClick={close}
          prefetchMode="eager"
        >
          <MessageSquareText aria-hidden="true" size={18} /> Threads
        </ViewLink>
        <button disabled title="Activity is not available yet" type="button">
          <Bell aria-hidden="true" size={18} /> Activity
        </button>
      </nav>

      <ChannelGroup
        channels={channelGroups.streams}
        label="Channels"
        onNavigate={close}
        selectedId={selectedId}
      />
      {channelGroups.forums.length > 0 ? (
        <ChannelGroup
          channels={channelGroups.forums}
          label="Forums"
          onNavigate={close}
          selectedId={selectedId}
        />
      ) : null}
      {channelGroups.dms.length > 0 ? (
        <ChannelGroup
          channels={channelGroups.dms}
          label="Direct messages"
          onNavigate={close}
          selectedId={selectedId}
        />
      ) : null}

      <div className="identity-card">
        <Avatar profile={identity} small />
        <div>
          <strong>{identity.name}</strong>
          <span>Browser identity</span>
        </div>
        <span className="presence-dot" aria-label="Online" role="status" />
        <button
          aria-label="Sign out"
          className="logout-button"
          disabled={loggingOut}
          onClick={logout}
          type="button"
        >
          <LogOut aria-hidden="true" size={16} />
        </button>
      </div>
      {logoutError ? (
        <p className="sidebar-error" role="alert">
          {logoutError}
        </p>
      ) : null}
    </aside>
  );
}

function ChannelGroup({
  label,
  onNavigate,
  channels,
  selectedId,
}: {
  label: string;
  onNavigate: () => void;
  channels: ChannelView[];
  selectedId: string | null;
}) {
  if (channels.length === 0) return null;
  return (
    <div className="channel-group">
      <div className="channel-group-title">
        <ChevronDown aria-hidden="true" size={13} /> {label}
      </div>
      <nav aria-label={label}>
        {channels.map((channel) => (
          <ViewLink
            className={
              channel.id === selectedId
                ? "channel-link channel-link-active"
                : "channel-link"
            }
            href={`/channels/${channel.id}`}
            key={channel.id}
            onClick={onNavigate}
            prefetchMode="eager"
          >
            {channel.type === "dm" ? (
              <span className="dm-dot" />
            ) : channel.visibility === "private" ? (
              <LockKeyhole aria-hidden="true" size={14} />
            ) : (
              <Hash aria-hidden="true" size={15} />
            )}
            <span>{channel.name}</span>
          </ViewLink>
        ))}
      </nav>
    </div>
  );
}
