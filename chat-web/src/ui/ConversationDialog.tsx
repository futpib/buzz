"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { LoaderCircle, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { invalidateMentionSuggestions } from "@/client/use-mentions";
import { fetchView } from "@/client/fetch-view";
import {
  changeConversation,
  newChannelId,
  type ConversationResult,
} from "@/client/conversations";
import { signingIdentitySignal } from "@/client/identity";
import {
  PERSON_KEY,
  type ConversationAction,
  type ConversationDetails,
  type ConversationDirectory,
} from "@/shared/conversations";
import { Avatar } from "@/ui/Avatar";
import { ChannelSettings } from "@/ui/ChannelSettings";
import type { ProfileView } from "@/server/types";

const directories = new Map<string, ConversationDirectory>();
export function ConversationDialog({
  identity,
  channelId,
  close,
  onNavigate,
}: {
  identity: string;
  channelId?: string;
  close: () => void;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState(channelId ? "members" : "dm");
  const [directory, setDirectory] = useState<ConversationDirectory | null>(
    () => directories.get(identity) ?? null,
  );
  const [detail, setDetail] = useState<ConversationDetails | null>(null);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState(""),
    [about, setAbout] = useState("");
  const [visibility, setVisibility] = useState<"open" | "private">("open"),
    [type, setType] = useState<"stream" | "forum">("stream");
  const [destination, setDestination] = useState<string | null>(null);
  const createId = useRef<string | null>(null),
    dialog = useRef<HTMLElement>(null),
    mounted = useRef(true),
    writing = useRef(false),
    request = useRef<AbortController | null>(null);
  const refresh = useCallback(
    async (fresh = true) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const signal = AbortSignal.any([
        controller.signal,
        signingIdentitySignal(),
        AbortSignal.timeout(60_000),
      ]);
      setLoading(true);
      setError(null);
      try {
        const url = channelId
          ? `/api/conversations?channel=${channelId}`
          : `/api/conversations${fresh ? "?fresh=1" : ""}`;
        if (channelId)
          setDetail(
            await fetchView<ConversationDetails>(url, identity, signal),
          );
        else {
          let view = await fetchView<ConversationDirectory>(
            url,
            identity,
            signal,
          );
          setDirectory(view);
          directories.set(identity, view);
          if (directories.size > 8)
            directories.delete(directories.keys().next().value as string);
          if (view.cacheState === "stale") {
            view = await fetchView<ConversationDirectory>(
              "/api/conversations?fresh=1",
              identity,
              signal,
            );
            setDirectory(view);
            directories.set(identity, view);
          }
        }
      } catch (e) {
        if (!controller.signal.aborted && mounted.current)
          setError(
            e instanceof Error ? e.message : "Could not refresh conversations",
          );
      } finally {
        if (request.current === controller && mounted.current)
          setLoading(false);
      }
    },
    [identity, channelId],
  );
  useEffect(() => {
    mounted.current = true;
    void refresh(false);
    const focused = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const recover = () => {
      if (document.visibilityState === "visible" && !writing.current)
        void refresh(true);
    };
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    const timer = setInterval(recover, 30_000);
    return () => {
      mounted.current = false;
      request.current?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
      if (focused?.isConnected) focused.focus();
    };
  }, [refresh]);
  const navigate = (id: string) => {
    router.push(`/channels/${id}`);
    router.refresh();
    onNavigate?.();
    close();
  };
  const run = async (
    input: ConversationAction,
  ): Promise<ConversationResult | null> => {
    if (writing.current) return null;
    writing.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    request.current?.abort();
    try {
      const result = await changeConversation(identity, input);
      directories.delete(identity);
      if (result.channelId)
        invalidateMentionSuggestions(identity, result.channelId);
      if (!mounted.current) return result;
      if (!result.ready)
        setNotice(
          "Saved. The channel list is still catching up; refresh to see the latest state.",
        );
      if (input.action === "leave") {
        router.replace("/");
        router.refresh();
        onNavigate?.();
        close();
      } else if (
        input.action === "dm" ||
        input.action === "create" ||
        input.action === "join"
      ) {
        if (result.channelId && result.ready) navigate(result.channelId);
        else {
          setDestination(result.channelId);
          setNotice(
            "Conversation saved. Refresh the list before opening it; no need to create it again.",
          );
          await refresh(true);
        }
      } else {
        await refresh(true);
        router.refresh();
      }
      return result;
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : "Could not update conversation",
        );
      return null;
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const addPerson = async (pubkey: string) => {
    if (channelId) {
      await run({ action: "add", channelId, pubkey });
      setQuery("");
    } else
      setSelected((keys) =>
        keys.includes(pubkey)
          ? keys.filter((k) => k !== pubkey)
          : keys.length < 8
            ? [...keys, pubkey]
            : keys,
      );
  };
  const people = (directory?.people ?? []).filter(
    (p) =>
      !detail?.members.some((m) => m.pubkey === p.pubkey) &&
      `${p.name} ${p.pubkey}`.toLowerCase().includes(query.toLowerCase()),
  );
  let exactKey: string | null = null;
  try {
    const raw = query.trim();
    if (PERSON_KEY.test(raw)) exactKey = raw;
    else if (raw.startsWith("npub1")) {
      const decoded = nip19.decode(raw);
      if (decoded.type === "npub") exactKey = decoded.data;
    }
  } catch {}
  if (
    exactKey === identity ||
    detail?.members.some((m) => m.pubkey === exactKey)
  )
    exactKey = null;
  const loadPeople = async () => {
    setLoading(true);
    setError(null);
    try {
      const view = await fetchView<ConversationDirectory>(
        "/api/conversations?fresh=1",
        identity,
        AbortSignal.any([signingIdentitySignal(), AbortSignal.timeout(60_000)]),
      );
      if (mounted.current) setDirectory(view);
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "Could not load people");
    } finally {
      if (mounted.current) setLoading(false);
    }
  };
  return createPortal(
    <div className="dialog-backdrop conversation-backdrop">
      <section
        className="conversation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={channelId ? "Channel details" : "New conversation"}
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            close();
          }
          if (event.key === "Tab") {
            const nodes = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
              ),
            ].filter((n) => n.getClientRects().length);
            const first = nodes[0],
              last = nodes.at(-1);
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === event.currentTarget)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last ||
                document.activeElement === event.currentTarget)
            ) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <h2>
            {detail?.channel.name ??
              (channelId ? "Channel details" : "New conversation")}
          </h2>
          <button
            aria-label="Close conversation dialog"
            type="button"
            disabled={busy}
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>
        <nav className="conversation-tabs" aria-label="Conversation options">
          {(channelId
            ? [
                ["members", "Members"],
                ["settings", "Settings"],
              ]
            : [
                ["dm", "New message"],
                ["browse", "Browse channels"],
                ["create", "Create channel"],
              ]
          ).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={tab === key}
              type="button"
              disabled={busy}
              onClick={() => {
                setTab(key);
                setQuery("");
                setError(null);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="conversation-status" aria-live="polite">
          {loading ? (
            <span>
              <LoaderCircle size={15} className="spin" /> Updating…
            </span>
          ) : null}
          {busy ? <span>Saving…</span> : null}
          {notice ? <p>{notice}</p> : null}
        </div>
        {error ? (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          className="conversation-refresh"
          disabled={loading || busy}
          onClick={() => void refresh(true)}
        >
          Refresh
        </button>
        {destination ? (
          <button
            type="button"
            disabled={
              busy ||
              loading ||
              !directory?.channels.some((c) => c.id === destination && c.joined)
            }
            onClick={() => navigate(destination)}
          >
            Open saved conversation
          </button>
        ) : null}
        {tab === "create" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createId.current ??= newChannelId();
              void run({
                action: "create",
                channelId: createId.current,
                name,
                about,
                visibility,
                type,
              });
            }}
          >
            <label>
              Channel name
              <input
                value={name}
                maxLength={100}
                required
                disabled={busy || !!destination}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Description
              <textarea
                aria-label="Description"
                value={about}
                maxLength={8000}
                disabled={busy}
                onChange={(e) => setAbout(e.target.value)}
              />
            </label>
            <label>
              Channel type
              <select
                aria-label="Channel type"
                value={type}
                disabled={busy}
                onChange={(e) => setType(e.target.value as "stream" | "forum")}
              >
                <option value="stream">Chat</option>
                <option value="forum">Forum</option>
              </select>
            </label>
            <label>
              Visibility
              <select
                aria-label="Visibility"
                value={visibility}
                disabled={busy}
                onChange={(e) =>
                  setVisibility(e.target.value as "open" | "private")
                }
              >
                <option value="open">
                  Open — anyone in this community can join
                </option>
                <option value="private">Private — invitation required</option>
              </select>
            </label>
            <button
              type="submit"
              className="primary-button"
              disabled={busy || !!destination || !name.trim()}
            >
              Create channel
            </button>
          </form>
        ) : null}
        {tab === "browse" ? (
          <>
            <label>
              Find channels
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or description"
              />
            </label>
            <ul className="conversation-list">
              {directory?.channels
                .filter(
                  (c) =>
                    c.type !== "dm" &&
                    `${c.name} ${c.description}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                )
                .map((c) => (
                  <li key={c.id}>
                    <div>
                      <strong>
                        {c.visibility === "private" ? "🔒" : "#"} {c.name}
                      </strong>
                      <small>
                        {c.description || c.type}
                        {c.archived ? " · Archived" : ""}
                      </small>
                    </div>
                    <button
                      type="button"
                      disabled={busy || !!destination}
                      onClick={() =>
                        c.joined
                          ? navigate(c.id)
                          : void run({ action: "join", channelId: c.id })
                      }
                    >
                      {c.joined ? "Open" : "Join"}
                    </button>
                  </li>
                ))}
            </ul>
            {directory && !directory.channels.some((c) => c.type !== "dm") ? (
              <p>No channels available. Create one to get started.</p>
            ) : null}
          </>
        ) : null}
        {tab === "settings" && detail ? (
          <ChannelSettings
            key={detail.channel.id}
            detail={detail}
            busy={busy}
            run={run}
          />
        ) : null}
        {tab === "members" && detail ? (
          <>
            <ul className="conversation-list">
              {detail.members.map((person) => (
                <li key={person.pubkey}>
                  <Person person={person} />
                  <small>{person.role}</small>
                  {detail.canManage && person.pubkey !== identity ? (
                    <>
                      <select
                        aria-label={`Role for ${person.name} ${person.pubkey.slice(0, 8)}`}
                        value={person.role}
                        disabled={busy || detail.channel.archived}
                        onChange={(e) => {
                          const role = e.target.value;
                          if (
                            window.confirm(
                              `Change ${person.name}'s role to ${role}?`,
                            )
                          )
                            void run({
                              action: "add",
                              channelId: detail.channel.id,
                              pubkey: person.pubkey,
                              role,
                            });
                        }}
                      >
                        {["owner", "admin", "member", "guest", "bot"].map(
                          (role) => (
                            <option key={role}>{role}</option>
                          ),
                        )}
                      </select>
                      <button
                        aria-label={`Remove ${person.name} ${person.pubkey.slice(0, 8)}`}
                        type="button"
                        disabled={busy || detail.channel.archived}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove ${person.name} from this channel?`,
                            )
                          )
                            void run({
                              action: "remove",
                              channelId: detail.channel.id,
                              pubkey: person.pubkey,
                            });
                        }}
                      >
                        Remove
                      </button>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            {detail.channel.type !== "dm" && !detail.channel.archived ? (
              <>
                <h3>Add people</h3>
                {!directory ? (
                  <button
                    type="button"
                    disabled={busy || loading}
                    onClick={() => void loadPeople()}
                  >
                    Browse people
                  </button>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
        {tab === "dm" ||
        (tab === "members" &&
          detail &&
          detail.channel.type !== "dm" &&
          !detail.channel.archived) ? (
          <>
            <label>
              {tab === "dm" ? "To" : "Find people"}
              <input
                value={query}
                disabled={busy}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name, public key, or npub"
                onFocus={() => {
                  if (channelId && !directory && !loading) void loadPeople();
                }}
              />
            </label>
            {selected.length ? (
              <div className="conversation-selected">
                {selected.map((key) => (
                  <button
                    key={key}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      setSelected((keys) => keys.filter((k) => k !== key))
                    }
                  >
                    {directory?.people.find((p) => p.pubkey === key)?.name ??
                      key.slice(0, 12)}{" "}
                    ×
                  </button>
                ))}
              </div>
            ) : null}
            {exactKey && !people.some((p) => p.pubkey === exactKey) ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void addPerson(exactKey as string)}
              >
                {channelId ? "Add" : "Select"} {exactKey.slice(0, 16)}…
              </button>
            ) : null}
            <ul className="conversation-list">
              {people.slice(0, 100).map((person) => (
                <li key={person.pubkey}>
                  <Person person={person} />
                  <button
                    type="button"
                    disabled={
                      busy ||
                      (!selected.includes(person.pubkey) &&
                        selected.length >= 8)
                    }
                    aria-pressed={selected.includes(person.pubkey)}
                    onClick={() => void addPerson(person.pubkey)}
                  >
                    {channelId
                      ? "Add"
                      : selected.includes(person.pubkey)
                        ? "Selected"
                        : "Select"}
                  </button>
                </li>
              ))}
            </ul>
            {people.length > 100 ? (
              <p>
                Showing 100 matches. Narrow your search to find more people.
              </p>
            ) : null}
            {!loading && directory && people.length === 0 && !exactKey ? (
              <p>No matching people.</p>
            ) : null}
            {tab === "dm" ? (
              <button
                type="button"
                className="primary-button"
                disabled={busy || !!destination || selected.length === 0}
                onClick={() => void run({ action: "dm", pubkeys: selected })}
              >
                Start conversation
                {selected.length > 1 ? ` (${selected.length})` : ""}
              </button>
            ) : null}
          </>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
function Person({ person }: { person: ProfileView }) {
  return (
    <div className="conversation-person">
      <Avatar profile={person} small />
      <div>
        <strong>{person.name}</strong>
        <small title={person.pubkey}>{person.pubkey.slice(0, 12)}…</small>
      </div>
    </div>
  );
}
