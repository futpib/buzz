"use client";

import {
  Bell,
  ChevronDown,
  Hash,
  Inbox,
  LockKeyhole,
  MessageSquareText,
  PanelRightClose,
  Search,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ChannelSnapshot, WorkspaceView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { Composer } from "@/ui/Composer";
import { MessageRow } from "@/ui/MessageRow";

type LiveState = "connecting" | "live" | "reconnecting";

export function WorkspaceShell({ initial }: { initial: WorkspaceView }) {
  const [timeline, setTimeline] = useState(initial.timeline);
  const [thread, setThread] = useState(initial.thread);
  const [liveState, setLiveState] = useState<LiveState>("connecting");
  const timelineEnd = useRef<HTMLDivElement>(null);
  const rootId = initial.thread?.rootId ?? null;

  useEffect(() => {
    setTimeline(initial.timeline);
    setThread(initial.thread);
  }, [initial]);

  useEffect(() => {
    const params = new URLSearchParams({ channel: initial.selectedChannel.id });
    if (rootId) params.set("thread", rootId);
    const source = new EventSource(`/api/live?${params}`);
    source.onopen = () => setLiveState("live");
    source.onerror = () => setLiveState("reconnecting");
    source.addEventListener("snapshot", (event) => {
      const snapshot = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as ChannelSnapshot;
      setTimeline(snapshot.timeline);
      setThread(snapshot.thread);
      setLiveState("live");
    });
    return () => source.close();
  }, [initial.selectedChannel.id, rootId]);

  useEffect(() => {
    if (timeline.length >= 0) {
      timelineEnd.current?.scrollIntoView({ block: "end" });
    }
  }, [timeline.length]);

  const channelGroups = useMemo(() => {
    const active = initial.channels.filter((channel) => !channel.archived);
    return {
      streams: active.filter((channel) => channel.type === "stream"),
      forums: active.filter((channel) => channel.type === "forum"),
      dms: active.filter((channel) => channel.type === "dm"),
    };
  }, [initial.channels]);

  const forum = initial.selectedChannel.type === "forum";
  const liveLabel =
    liveState === "live"
      ? "Live"
      : liveState === "connecting"
        ? "Connecting"
        : "Reconnecting";

  return (
    <main className={thread ? "workspace workspace-thread-open" : "workspace"}>
      <aside className="sidebar">
        <div className="workspace-switcher">
          <span className="brand-mark">B</span>
          <span className="workspace-name">Buzz</span>
          <ChevronDown aria-hidden="true" size={15} />
        </div>
        <nav className="primary-nav" aria-label="Workspace">
          <button type="button">
            <Inbox aria-hidden="true" size={18} /> Inbox
          </button>
          <button type="button">
            <MessageSquareText aria-hidden="true" size={18} /> Threads
          </button>
          <button type="button">
            <Bell aria-hidden="true" size={18} /> Activity
          </button>
        </nav>

        <ChannelGroup
          channels={channelGroups.streams}
          label="Channels"
          selectedId={initial.selectedChannel.id}
        />
        {channelGroups.forums.length > 0 ? (
          <ChannelGroup
            channels={channelGroups.forums}
            label="Forums"
            selectedId={initial.selectedChannel.id}
          />
        ) : null}
        {channelGroups.dms.length > 0 ? (
          <ChannelGroup
            channels={channelGroups.dms}
            label="Direct messages"
            selectedId={initial.selectedChannel.id}
          />
        ) : null}

        <div className="identity-card">
          <Avatar profile={initial.identity} small />
          <div>
            <strong>{initial.identity.name}</strong>
            <span>Server identity</span>
          </div>
          <span className="presence-dot" aria-label="Online" role="status" />
        </div>
      </aside>

      <section className="channel-panel">
        <header className="channel-header">
          <div className="channel-title">
            {initial.selectedChannel.visibility === "private" ? (
              <LockKeyhole aria-hidden="true" size={17} />
            ) : (
              <Hash aria-hidden="true" size={19} />
            )}
            <div>
              <h1>{initial.selectedChannel.name}</h1>
              {initial.selectedChannel.description ? (
                <p>{initial.selectedChannel.description}</p>
              ) : null}
            </div>
          </div>
          <div className="header-actions">
            <span className={`live-status live-${liveState}`}>
              <span /> {liveLabel}
            </span>
            <button aria-label="Channel members" type="button">
              <Users aria-hidden="true" size={18} />
            </button>
            <button aria-label="Search" type="button">
              <Search aria-hidden="true" size={18} />
            </button>
          </div>
        </header>

        <div className="timeline">
          <div className="channel-intro">
            <div className="intro-icon">
              {forum ? <MessageSquareText size={25} /> : <Hash size={27} />}
            </div>
            <h2>{initial.selectedChannel.name}</h2>
            <p>
              {initial.selectedChannel.description ||
                `This is the start of #${initial.selectedChannel.name}.`}
            </p>
          </div>
          {timeline.length === 0 ? (
            <p className="empty-timeline">
              No messages yet. Start the conversation.
            </p>
          ) : (
            timeline.map((message) => (
              <MessageRow
                channelId={initial.selectedChannel.id}
                key={message.id}
                message={message}
              />
            ))
          )}
          <div ref={timelineEnd} />
        </div>
        <Composer
          channelId={initial.selectedChannel.id}
          channelName={initial.selectedChannel.name}
          forum={forum}
        />
      </section>

      {thread ? (
        <aside className="thread-panel">
          <header className="thread-header">
            <div>
              <h2>Thread</h2>
              <span>#{initial.selectedChannel.name}</span>
            </div>
            <Link
              aria-label="Close thread"
              className="icon-link"
              href={`/channels/${initial.selectedChannel.id}`}
              scroll={false}
            >
              <X aria-hidden="true" size={19} />
            </Link>
          </header>
          <div className="thread-messages">
            {thread.root ? (
              <MessageRow
                channelId={initial.selectedChannel.id}
                hideThreadLink
                message={thread.root}
              />
            ) : (
              <p className="thread-unavailable">
                This message is no longer available.
              </p>
            )}
            <div className="reply-divider">
              <span>
                {thread.replies.length}{" "}
                {thread.replies.length === 1 ? "reply" : "replies"}
              </span>
              <i />
            </div>
            {thread.replies.map((message) => (
              <MessageRow
                channelId={initial.selectedChannel.id}
                compact
                hideThreadLink
                key={message.id}
                message={message}
              />
            ))}
          </div>
          <Composer
            channelId={initial.selectedChannel.id}
            channelName={initial.selectedChannel.name}
            forum={forum}
            rootId={thread.rootId}
          />
        </aside>
      ) : (
        <button
          className="thread-panel-hint"
          aria-label="No thread open"
          type="button"
        >
          <PanelRightClose aria-hidden="true" size={17} />
        </button>
      )}
    </main>
  );
}

function ChannelGroup({
  label,
  channels,
  selectedId,
}: {
  label: string;
  channels: WorkspaceView["channels"];
  selectedId: string;
}) {
  if (channels.length === 0) return null;
  return (
    <div className="channel-group">
      <div className="channel-group-title">
        <ChevronDown aria-hidden="true" size={13} /> {label}
      </div>
      <nav aria-label={label}>
        {channels.map((channel) => (
          <Link
            className={
              channel.id === selectedId
                ? "channel-link channel-link-active"
                : "channel-link"
            }
            href={`/channels/${channel.id}`}
            key={channel.id}
          >
            {channel.type === "dm" ? (
              <span className="dm-dot" />
            ) : channel.visibility === "private" ? (
              <LockKeyhole aria-hidden="true" size={14} />
            ) : (
              <Hash aria-hidden="true" size={15} />
            )}
            <span>{channel.name}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
