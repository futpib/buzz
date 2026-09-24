"use client";

import {
  Archive,
  Bell,
  BellOff,
  ChevronDown,
  ChevronUp,
  Hash,
  Inbox,
  LockKeyhole,
  LogOut,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Settings2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { forgetCredential } from "@/client/identity";
import {
  navigationMetaForChannel,
  type NavigationSection,
  type NavigationSortGroup,
  type NavigationSortMode,
  useWorkspaceNavigation,
} from "@/client/workspace-navigation";
import type { ChannelView, ProfileView } from "@/server/types";
import { Avatar } from "@/ui/Avatar";
import { SearchDialog } from "@/ui/SearchDialog";
import { ViewLink } from "@/ui/ViewLink";

type ChannelMenu = { channel: ChannelView; x: number; y: number };

export function WorkspaceSidebar({
  activePage,
  channels,
  close,
  identity,
  selectedId,
}: {
  activePage: "activity" | "channel" | "inbox" | "sent" | "threads";
  channels: ChannelView[];
  close: () => void;
  identity: ProfileView;
  selectedId: string | null;
}) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [channelMenu, setChannelMenu] = useState<ChannelMenu | null>(null);
  const { snapshot, controller } = useWorkspaceNavigation(
    identity.pubkey,
    channels,
  );
  const metadata = useMemo(
    () =>
      new Map(
        channels.map((channel) => [
          channel.id,
          navigationMetaForChannel(snapshot, channel.id),
        ]),
      ),
    [channels, snapshot],
  );
  const groups = useMemo(() => {
    const active = channels.filter((channel) => !channel.archived);
    const starred = active.filter(
      (channel) => metadata.get(channel.id)?.starred,
    );
    const custom = snapshot.sections.map((section) => ({
      section,
      channels: active.filter(
        (channel) =>
          !metadata.get(channel.id)?.starred &&
          snapshot.assignments[channel.id] === section.id,
      ),
    }));
    const unassigned = active.filter(
      (channel) =>
        !metadata.get(channel.id)?.starred && !snapshot.assignments[channel.id],
    );
    return {
      starred,
      custom,
      streams: unassigned.filter((channel) => channel.type === "stream"),
      forums: unassigned.filter((channel) => channel.type === "forum"),
      dms: unassigned.filter((channel) => channel.type === "dm"),
      archived: channels.filter((channel) => channel.archived),
    };
  }, [channels, metadata, snapshot.assignments, snapshot.sections]);
  const inboxCount = [...metadata.values()].reduce(
    (total, meta) => total + meta.highPriorityCount,
    0,
  );

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

  const group = (
    label: string,
    groupKey: NavigationSortGroup,
    groupedChannels: ChannelView[],
  ) => (
    <ChannelGroup
      channels={groupedChannels}
      groupKey={groupKey}
      key={groupKey}
      label={label}
      metadata={metadata}
      onMenu={(channel, point) =>
        setChannelMenu({ channel, x: point.x, y: point.y })
      }
      onNavigate={close}
      selectedId={selectedId}
      setSort={(mode) => controller.setSort(groupKey, mode)}
      sortMode={snapshot.sort[groupKey] ?? "alpha"}
    />
  );

  return (
    <aside
      className="sidebar"
      data-navigation-candidates={snapshot.candidates.length}
      data-navigation-ready={snapshot.ready}
      id="channel-navigation"
    >
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
        <button
          aria-controls="workspace-search"
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen(true)}
          type="button"
        >
          <Search aria-hidden="true" size={18} /> Search
        </button>
        <ViewLink
          className={activePage === "inbox" ? "primary-nav-active" : undefined}
          href="/inbox"
          onClick={close}
          prefetchMode="eager"
        >
          <Inbox aria-hidden="true" size={18} /> <span>Inbox</span>
          {inboxCount > 0 ? (
            <span
              className="nav-unread-badge"
              aria-label={`${inboxCount} unread mentions`}
              role="status"
            >
              {inboxCount > 99 ? "99+" : inboxCount}
            </span>
          ) : null}
        </ViewLink>
        <ViewLink
          className={activePage === "sent" ? "primary-nav-active" : undefined}
          href="/sent"
          onClick={close}
          prefetchMode="eager"
        >
          <Send aria-hidden="true" size={18} /> Sent
        </ViewLink>
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
        <ViewLink
          className={
            activePage === "activity" ? "primary-nav-active" : undefined
          }
          href="/activity"
          onClick={close}
          prefetchMode="eager"
        >
          <Bell aria-hidden="true" size={18} /> Activity
        </ViewLink>
      </nav>

      <div className="sidebar-channels-heading">
        <span>Channels</span>
        <button
          aria-label="Organize channels and notifications"
          onClick={() => setOrganizeOpen(true)}
          type="button"
        >
          <Settings2 aria-hidden="true" size={15} />
        </button>
      </div>
      {group("Starred", "starred", groups.starred)}
      {groups.custom.map(({ section, channels: sectionChannels }) =>
        group(section.name, `section:${section.id}`, sectionChannels),
      )}
      {group("Channels", "channels", groups.streams)}
      {group("Forums", "forums", groups.forums)}
      {group("Direct messages", "dms", groups.dms)}
      {groups.archived.length > 0 ? (
        <div className="channel-group archived-channel-group">
          <button
            aria-expanded={snapshot.archivedOpen}
            className="channel-group-title channel-group-toggle"
            onClick={() => controller.setArchivedOpen(!snapshot.archivedOpen)}
            type="button"
          >
            <ChevronDown
              aria-hidden="true"
              className={snapshot.archivedOpen ? undefined : "chevron-closed"}
              size={13}
            />
            Archived <span>{groups.archived.length}</span>
          </button>
          {snapshot.archivedOpen ? (
            <ChannelList
              channels={groups.archived}
              metadata={metadata}
              onMenu={(channel, point) =>
                setChannelMenu({ channel, x: point.x, y: point.y })
              }
              onNavigate={close}
              selectedId={selectedId}
            />
          ) : null}
        </div>
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
      {snapshot.error || logoutError ? (
        <p className="sidebar-error" role="alert">
          {logoutError ?? snapshot.error}
        </p>
      ) : null}
      {channelMenu ? (
        <ChannelContextMenu
          channel={channelMenu.channel}
          close={() => setChannelMenu(null)}
          controller={controller}
          meta={metadata.get(channelMenu.channel.id)}
          point={channelMenu}
          sections={snapshot.sections}
          selectedSection={snapshot.assignments[channelMenu.channel.id] ?? null}
        />
      ) : null}
      {organizeOpen ? (
        <OrganizeDialog
          close={() => setOrganizeOpen(false)}
          controller={controller}
          notifications={snapshot.notifications}
          sections={snapshot.sections}
        />
      ) : null}
      {searchOpen ? (
        <SearchDialog
          close={() => setSearchOpen(false)}
          viewerPubkey={identity.pubkey}
        />
      ) : null}
    </aside>
  );
}

function ChannelGroup({
  label,
  onNavigate,
  channels,
  selectedId,
  metadata,
  onMenu,
  groupKey,
  sortMode,
  setSort,
}: {
  label: string;
  onNavigate: () => void;
  channels: ChannelView[];
  selectedId: string | null;
  metadata: Map<string, ReturnType<typeof navigationMetaForChannel>>;
  onMenu: (channel: ChannelView, point: { x: number; y: number }) => void;
  groupKey: NavigationSortGroup;
  sortMode: NavigationSortMode;
  setSort: (mode: NavigationSortMode) => void;
}) {
  if (channels.length === 0) return null;
  const sorted = [...channels].sort((left, right) => {
    const leftMeta = metadata.get(left.id);
    const rightMeta = metadata.get(right.id);
    const unreadDelta =
      Number((rightMeta?.unreadCount ?? 0) > 0) -
      Number((leftMeta?.unreadCount ?? 0) > 0);
    if (unreadDelta) return unreadDelta;
    if (sortMode === "recent") {
      const activity =
        (rightMeta?.lastActivityAt ?? 0) - (leftMeta?.lastActivityAt ?? 0);
      if (activity) return activity;
    }
    return (
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    );
  });
  return (
    <div className="channel-group" data-group={groupKey}>
      <div className="channel-group-title">
        <ChevronDown aria-hidden="true" size={13} /> <span>{label}</span>
        <button
          aria-label={`Sort ${label} by ${sortMode === "alpha" ? "recent activity" : "name"}`}
          className="channel-sort-button"
          onClick={() => setSort(sortMode === "alpha" ? "recent" : "alpha")}
          title={
            sortMode === "alpha" ? "Sorted A–Z" : "Sorted by recent activity"
          }
          type="button"
        >
          {sortMode === "alpha" ? "A–Z" : "Recent"}
        </button>
      </div>
      <ChannelList
        channels={sorted}
        metadata={metadata}
        onMenu={onMenu}
        onNavigate={onNavigate}
        selectedId={selectedId}
      />
    </div>
  );
}

function ChannelList({
  channels,
  selectedId,
  onNavigate,
  metadata,
  onMenu,
}: {
  channels: ChannelView[];
  selectedId: string | null;
  onNavigate: () => void;
  metadata: Map<string, ReturnType<typeof navigationMetaForChannel>>;
  onMenu: (channel: ChannelView, point: { x: number; y: number }) => void;
}) {
  return (
    <nav aria-label="Channel list">
      {channels.map((channel) => {
        const meta = metadata.get(channel.id);
        return (
          <div className="channel-link-row" key={channel.id}>
            <ViewLink
              className={`${channel.id === selectedId ? "channel-link channel-link-active" : "channel-link"}${(meta?.unreadCount ?? 0) > 0 ? " channel-link-unread" : ""}`}
              href={`/channels/${channel.id}`}
              onClick={onNavigate}
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu(channel, { x: event.clientX, y: event.clientY });
              }}
              prefetchMode="intent"
            >
              {channel.type === "dm" ? (
                <span className="dm-dot" />
              ) : channel.visibility === "private" ? (
                <LockKeyhole aria-hidden="true" size={14} />
              ) : (
                <Hash aria-hidden="true" size={15} />
              )}
              <span>{channel.name}</span>
              {meta?.muted ? <BellOff aria-label="Muted" size={13} /> : null}
              {(meta?.unreadCount ?? 0) > 0 ? (
                <span
                  className={
                    (meta?.highPriorityCount ?? 0) > 0
                      ? "channel-unread-badge channel-unread-priority"
                      : "channel-unread-badge"
                  }
                  aria-label={`${meta?.unreadCount} unread`}
                  role="status"
                >
                  {(meta?.unreadCount ?? 0) > 99 ? "99+" : meta?.unreadCount}
                </span>
              ) : null}
            </ViewLink>
            <button
              aria-label={`Actions for ${channel.name}`}
              className="channel-menu-button"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onMenu(channel, { x: rect.right, y: rect.bottom });
              }}
              type="button"
            >
              <MoreHorizontal aria-hidden="true" size={15} />
            </button>
          </div>
        );
      })}
    </nav>
  );
}

function ChannelContextMenu({
  channel,
  close,
  controller,
  meta,
  point,
  sections,
  selectedSection,
}: {
  channel: ChannelView;
  close: () => void;
  controller: ReturnType<typeof useWorkspaceNavigation>["controller"];
  meta: ReturnType<typeof navigationMetaForChannel> | undefined;
  point: { x: number; y: number };
  sections: NavigationSection[];
  selectedSection: string | null;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [close]);
  return (
    <div
      className="channel-context-menu"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
      ref={menu}
      role="menu"
      style={
        {
          "--channel-menu-x": `${point.x}px`,
          "--channel-menu-y": `${point.y}px`,
        } as CSSProperties
      }
      tabIndex={-1}
    >
      <strong>{channel.name}</strong>
      <button
        onClick={() => {
          if ((meta?.unreadCount ?? 0) > 0)
            controller.markChannelRead(channel.id);
          else controller.markChannelUnread(channel.id);
          close();
        }}
        role="menuitem"
        type="button"
      >
        {(meta?.unreadCount ?? 0) > 0 ? "Mark read" : "Mark unread"}
      </button>
      <button
        onClick={() => {
          controller.toggleStar(channel.id);
          close();
        }}
        role="menuitem"
        type="button"
      >
        <Star aria-hidden="true" size={15} />{" "}
        {meta?.starred ? "Unstar" : "Star"}
      </button>
      <button
        onClick={() => {
          controller.toggleMute(channel.id);
          close();
        }}
        role="menuitem"
        type="button"
      >
        <BellOff aria-hidden="true" size={15} />{" "}
        {meta?.muted ? "Unmute" : "Mute"}
      </button>
      {sections.length > 0 ? (
        <label>
          Move to section
          <select
            onChange={(event) => {
              controller.assignSection(channel.id, event.target.value || null);
              close();
            }}
            value={selectedSection ?? ""}
          >
            <option value="">No section</option>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {channel.archived ? (
        <span className="channel-menu-note">
          <Archive aria-hidden="true" size={14} /> Archived channel
        </span>
      ) : null}
    </div>
  );
}

function OrganizeDialog({
  close,
  controller,
  notifications,
  sections,
}: {
  close: () => void;
  controller: ReturnType<typeof useWorkspaceNavigation>["controller"];
  notifications: boolean;
  sections: NavigationSection[];
}) {
  const [name, setName] = useState("");
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return createPortal(
    <div
      aria-labelledby="organize-channels-title"
      aria-modal="true"
      className="dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
      role="dialog"
    >
      <section className="organize-dialog">
        <header>
          <div>
            <h2 id="organize-channels-title">Channels & notifications</h2>
            <p>Organize this sidebar across your Buzz clients.</p>
          </div>
          <button aria-label="Close" onClick={close} type="button">
            <X aria-hidden="true" size={19} />
          </button>
        </header>
        <div className="notification-setting">
          <div>
            <strong>Browser notifications</strong>
            <span>Mentions and unmuted live messages while Buzz is open.</span>
          </div>
          <button
            onClick={() => {
              setPermissionError(null);
              if (notifications) controller.disableNotifications();
              else {
                void controller.enableNotifications().then((enabled) => {
                  if (!enabled)
                    setPermissionError(
                      "Notification permission was not granted.",
                    );
                });
              }
            }}
            type="button"
          >
            {notifications ? "Disable" : "Enable"}
          </button>
        </div>
        {permissionError ? (
          <p className="dialog-error" role="alert">
            {permissionError}
          </p>
        ) : null}
        <div className="section-editor">
          <h3>Custom sections</h3>
          {sections.length === 0 ? <p>No custom sections yet.</p> : null}
          {sections.map((section) => (
            <div className="section-editor-row" key={section.id}>
              <span>{section.name}</span>
              <button
                aria-label={`Move ${section.name} up`}
                disabled={section === sections[0]}
                onClick={() => controller.moveSection(section.id, -1)}
                type="button"
              >
                <ChevronUp aria-hidden="true" size={15} />
              </button>
              <button
                aria-label={`Move ${section.name} down`}
                disabled={section === sections.at(-1)}
                onClick={() => controller.moveSection(section.id, 1)}
                type="button"
              >
                <ChevronDown aria-hidden="true" size={15} />
              </button>
              <button
                aria-label={`Delete ${section.name}`}
                onClick={() => controller.deleteSection(section.id)}
                type="button"
              >
                <Trash2 aria-hidden="true" size={15} />
              </button>
            </div>
          ))}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              controller.createSection(name);
              setName("");
            }}
          >
            <input
              aria-label="New section name"
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              placeholder="Section name"
              ref={input}
              value={name}
            />
            <button disabled={!name.trim()} type="submit">
              <Plus aria-hidden="true" size={15} /> Add
            </button>
          </form>
        </div>
      </section>
    </div>,
    document.body,
  );
}
