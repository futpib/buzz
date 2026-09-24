"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  decryptOwnAppDataEvent,
  loadSigningCredential,
  makeEncryptedAppDataEvent,
} from "@/client/identity";
import type {
  ChannelView,
  NavigationCandidateView,
  NavigationWorkspaceView,
} from "@/server/types";

type ToggleEntry = { value: boolean; updatedAt: number };
export type NavigationSection = { id: string; name: string; order: number };
export type NavigationSortMode = "alpha" | "recent";
export type NavigationSortGroup =
  | "starred"
  | "channels"
  | "forums"
  | "dms"
  | `section:${string}`;

type StoredNavigation = {
  version: 1;
  clientId: string;
  readContexts: Record<string, number>;
  forcedUnread: Record<string, string>;
  stars: Record<string, ToggleEntry>;
  mutes: Record<string, ToggleEntry>;
  sections: NavigationSection[];
  assignments: Record<string, string>;
  sort: Record<string, NavigationSortMode>;
  notifications: boolean;
  archivedOpen: boolean;
};

export type NavigationSnapshot = StoredNavigation & {
  ready: boolean;
  candidates: NavigationCandidateView[];
  error: string | null;
};

export type ChannelNavigationMeta = {
  unreadCount: number;
  highPriorityCount: number;
  firstUnreadId: string | null;
  lastActivityAt: number;
  muted: boolean;
  starred: boolean;
};

const STORAGE_PREFIX = "buzz.web-navigation.v1";
const MAX_CANDIDATES = 5_000;
const PUBLISH_DELAY_MS = 800;
const EMPTY: NavigationSnapshot = {
  version: 1,
  clientId: "pending",
  readContexts: {},
  forcedUnread: {},
  stars: {},
  mutes: {},
  sections: [],
  assignments: {},
  sort: {},
  notifications: false,
  archivedOpen: false,
  ready: false,
  candidates: [],
  error: null,
};

function storageKey(pubkey: string): string {
  return `${STORAGE_PREFIX}:${pubkey.toLowerCase()}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomClientId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now().toString(36)}`;
}

function parseToggleEntries(value: unknown): Record<string, ToggleEntry> {
  if (!record(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, raw]): [string, ToggleEntry][] => {
      if (!record(raw)) return [];
      const enabled = raw.value ?? raw.starred ?? raw.muted;
      return typeof enabled === "boolean" &&
        typeof raw.updatedAt === "number" &&
        Number.isFinite(raw.updatedAt)
        ? [[id, { value: enabled, updatedAt: raw.updatedAt }]]
        : [];
    }),
  );
}

function parseReadContexts(value: unknown): Record<string, number> {
  if (!record(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" &&
        Number.isInteger(entry[1]) &&
        entry[1] >= 0 &&
        entry[1] <= 4_294_967_295,
    ),
  );
}

function parseSections(value: unknown): NavigationSection[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((raw): NavigationSection[] => {
      if (
        !record(raw) ||
        typeof raw.id !== "string" ||
        typeof raw.name !== "string" ||
        typeof raw.order !== "number"
      ) {
        return [];
      }
      return [{ id: raw.id, name: raw.name.trim(), order: raw.order }];
    })
    .filter((section) => section.name.length > 0)
    .sort((a, b) => a.order - b.order)
    .slice(0, 100);
}

function parseAssignments(value: unknown): Record<string, string> {
  if (!record(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function parseSort(value: unknown): Record<string, NavigationSortMode> {
  if (!record(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, NavigationSortMode] =>
        entry[1] === "alpha" || entry[1] === "recent",
    ),
  );
}

function readLocal(pubkey: string): StoredNavigation {
  const fallback: StoredNavigation = {
    ...EMPTY,
    clientId: randomClientId(),
  };
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(storageKey(pubkey)) ?? "null",
    ) as unknown;
    if (!record(parsed) || parsed.version !== 1) return fallback;
    return {
      version: 1,
      clientId:
        typeof parsed.clientId === "string" && parsed.clientId.length <= 64
          ? parsed.clientId
          : fallback.clientId,
      readContexts: parseReadContexts(parsed.readContexts),
      forcedUnread: parseAssignments(parsed.forcedUnread),
      stars: parseToggleEntries(parsed.stars),
      mutes: parseToggleEntries(parsed.mutes),
      sections: parseSections(parsed.sections),
      assignments: parseAssignments(parsed.assignments),
      sort: parseSort(parsed.sort),
      notifications: parsed.notifications === true,
      archivedOpen: parsed.archivedOpen === true,
    };
  } catch {
    return fallback;
  }
}

function mergeToggles(
  local: Record<string, ToggleEntry>,
  remote: Record<string, ToggleEntry>,
): Record<string, ToggleEntry> {
  const result = { ...local };
  for (const [id, entry] of Object.entries(remote)) {
    if (!result[id] || entry.updatedAt > result[id].updatedAt) {
      result[id] = entry;
    }
  }
  return result;
}

function candidateUnread(
  snapshot: NavigationSnapshot,
  candidate: NavigationCandidateView,
): boolean {
  if (candidate.isOwn) return false;
  const forcedId = snapshot.forcedUnread[candidate.channelId];
  if (forcedId) {
    const forced = snapshot.candidates.find((item) => item.id === forcedId);
    if (
      !forced ||
      candidate.createdAt > forced.createdAt ||
      (candidate.createdAt === forced.createdAt && candidate.id >= forced.id)
    ) {
      return true;
    }
  }
  const readAt = Math.max(
    candidate.rootId ? 0 : (snapshot.readContexts[candidate.channelId] ?? 0),
    snapshot.readContexts[`msg:${candidate.id}`] ?? 0,
    candidate.rootId
      ? (snapshot.readContexts[`thread:${candidate.rootId}`] ?? 0)
      : 0,
  );
  return candidate.createdAt > readAt;
}

export function navigationMetaForChannel(
  snapshot: NavigationSnapshot,
  channelId: string,
): ChannelNavigationMeta {
  const candidates = snapshot.candidates.filter(
    (candidate) => candidate.channelId === channelId,
  );
  const unread = candidates.filter((candidate) =>
    candidateUnread(snapshot, candidate),
  );
  const highPriorityCount = unread.filter(
    (candidate) => candidate.highPriority,
  ).length;
  const muted = snapshot.mutes[channelId]?.value === true;
  return {
    unreadCount: muted ? highPriorityCount : unread.length,
    highPriorityCount,
    firstUnreadId: unread[0]?.id ?? null,
    lastActivityAt: candidates.at(-1)?.createdAt ?? 0,
    muted,
    starred: snapshot.stars[channelId]?.value === true,
  };
}

export function navigationUnreadForThread(
  snapshot: NavigationSnapshot,
  rootId: string,
): {
  unreadCount: number;
  highPriorityCount: number;
  firstUnreadId: string | null;
} {
  const unread = snapshot.candidates.filter(
    (candidate) =>
      candidate.rootId === rootId && candidateUnread(snapshot, candidate),
  );
  const highPriorityCount = unread.filter(
    (candidate) => candidate.highPriority,
  ).length;
  const channelId = unread[0]?.channelId;
  const visible =
    channelId && snapshot.mutes[channelId]?.value === true
      ? unread.filter((candidate) => candidate.highPriority)
      : unread;
  return {
    unreadCount: visible.length,
    highPriorityCount,
    firstUnreadId: visible[0]?.id ?? null,
  };
}

class NavigationController {
  private listeners = new Set<() => void>();
  private channels: ChannelView[] = [];
  private source: EventSource | null = null;
  private started = false;
  private bootstrapAttempt = 0;
  private initialReadStateSeeded = false;
  private publishTimers = new Map<string, number>();
  private publishCreatedAt = new Map<string, number>();
  private publishAttempts = new Map<string, number>();
  private pendingCoordinates = new Set<string>();
  private publishedEventIds = new Map<string, string>();
  snapshot: NavigationSnapshot;

  constructor(readonly pubkey: string) {
    this.snapshot = {
      ...readLocal(pubkey),
      ...{ ready: false, candidates: [], error: null },
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  updateChannels(channels: ChannelView[]) {
    this.channels = channels;
  }

  private commit(next: Partial<NavigationSnapshot>, persist = true) {
    this.snapshot = { ...this.snapshot, ...next };
    if (persist) {
      try {
        const {
          ready: _ready,
          candidates: _candidates,
          error: _error,
          ...stored
        } = this.snapshot;
        window.localStorage.setItem(
          storageKey(this.pubkey),
          JSON.stringify(stored),
        );
      } catch {
        // Navigation remains usable for the current tab when storage is denied.
      }
    }
    for (const listener of this.listeners) listener();
  }

  start() {
    if (this.started) return;
    this.started = true;
    void this.bootstrap();
  }

  private async bootstrap() {
    try {
      const response = await fetch("/api/navigation", {
        cache: "no-store",
      });
      if (response.status === 401) {
        window.location.assign(
          `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
        );
        return;
      }
      if (!response.ok) throw new Error("Navigation state could not be loaded");
      await this.applyWorkspace(
        (await response.json()) as NavigationWorkspaceView,
      );
      this.bootstrapAttempt = 0;
      this.connectLive();
    } catch (error) {
      this.commit({
        ready: true,
        error:
          error instanceof Error
            ? error.message
            : "Navigation state could not be loaded",
      });
      this.bootstrapAttempt += 1;
      if (this.bootstrapAttempt <= 5) {
        window.setTimeout(
          () => void this.bootstrap(),
          Math.min(8_000, 1_000 * 2 ** (this.bootstrapAttempt - 1)),
        );
      }
    }
  }

  private async applyWorkspace(view: NavigationWorkspaceView) {
    const credential = await loadSigningCredential(this.pubkey);
    const readContexts = { ...this.snapshot.readContexts };
    let stars = { ...this.snapshot.stars };
    let mutes = { ...this.snapshot.mutes };
    let sections = this.snapshot.sections;
    let assignments = this.snapshot.assignments;
    let sort = this.snapshot.sort;
    let sectionsHead = -1;
    let sortHead = -1;
    if (credential) {
      for (const event of view.appDataEvents) {
        let value: unknown;
        try {
          value = decryptOwnAppDataEvent(credential, event);
        } catch {
          continue;
        }
        const coordinate = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (coordinate) {
          this.publishCreatedAt.set(
            coordinate,
            Math.max(
              this.publishCreatedAt.get(coordinate) ?? 0,
              event.created_at,
            ),
          );
          if (this.publishedEventIds.get(coordinate) === event.id) {
            this.pendingCoordinates.delete(coordinate);
            this.publishedEventIds.delete(coordinate);
          }
        }
        if (coordinate?.startsWith("read-state:")) {
          if (record(value) && value.v === 1) {
            const remote = parseReadContexts(value.contexts);
            for (const [key, timestamp] of Object.entries(remote)) {
              readContexts[key] = Math.max(readContexts[key] ?? 0, timestamp);
            }
          }
        } else if (coordinate === "channel-stars" && record(value)) {
          stars = mergeToggles(stars, parseToggleEntries(value.channels));
        } else if (coordinate === "channel-mutes" && record(value)) {
          mutes = mergeToggles(mutes, parseToggleEntries(value.channels));
        } else if (
          coordinate === "channel-sections" &&
          !this.pendingCoordinates.has(coordinate) &&
          event.created_at > sectionsHead &&
          record(value)
        ) {
          sections = parseSections(value.sections);
          assignments = parseAssignments(value.assignments);
          sectionsHead = event.created_at;
        } else if (
          coordinate === "channel-sort" &&
          !this.pendingCoordinates.has(coordinate) &&
          event.created_at > sortHead &&
          record(value)
        ) {
          sort = parseSort(value.groups);
          sortHead = event.created_at;
        }
      }
    }
    const candidates = [
      ...new Map(view.candidates.map((item) => [item.id, item])).values(),
    ]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(-MAX_CANDIDATES);
    let seededReadState = false;
    if (
      !this.initialReadStateSeeded &&
      Object.keys(readContexts).length === 0
    ) {
      for (const channel of this.channels) {
        if (readContexts[channel.id] === undefined) {
          const latestRoot = candidates
            .filter(
              (candidate) =>
                candidate.channelId === channel.id && !candidate.rootId,
            )
            .at(-1);
          if (latestRoot) {
            readContexts[channel.id] = latestRoot.createdAt;
            seededReadState = true;
          }
        }
      }
      const threadIds = new Set(
        candidates.flatMap((candidate) =>
          candidate.rootId ? [candidate.rootId] : [],
        ),
      );
      for (const rootId of threadIds) {
        const key = `thread:${rootId}`;
        if (readContexts[key] !== undefined) continue;
        const latestReply = candidates
          .filter((candidate) => candidate.rootId === rootId)
          .at(-1);
        if (latestReply) {
          readContexts[key] = latestReply.createdAt;
          seededReadState = true;
        }
      }
      this.initialReadStateSeeded = true;
    }
    this.commit({
      candidates,
      readContexts,
      stars,
      mutes,
      sections,
      assignments,
      sort,
      ready: true,
      error: null,
    });
    if (seededReadState) {
      this.schedulePublish(`read-state:${this.snapshot.clientId}`);
    }
  }

  private connectLive() {
    this.source?.close();
    const source = new EventSource("/api/navigation/live");
    this.source = source;
    source.addEventListener("snapshot", (event) => {
      void this.applyWorkspace(
        JSON.parse(
          (event as MessageEvent<string>).data,
        ) as NavigationWorkspaceView,
      );
    });
    source.addEventListener("candidate", (event) => {
      const candidate = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as NavigationCandidateView;
      this.notify(candidate);
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        this.commit({ error: "Live navigation updates disconnected" }, false);
      }
    };
  }

  private notify(candidate: NavigationCandidateView) {
    if (
      !this.snapshot.notifications ||
      candidate.isOwn ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      return;
    }
    const muted = this.snapshot.mutes[candidate.channelId]?.value === true;
    if (muted && !candidate.highPriority) return;
    const notification = new Notification(
      candidate.highPriority
        ? `${candidate.author.name} mentioned you in #${candidate.channelName}`
        : `New message in #${candidate.channelName}`,
      { body: candidate.content.slice(0, 180), tag: candidate.id },
    );
    notification.onclick = () => {
      window.focus();
      window.location.assign(
        `/channels/${candidate.channelId}?${new URLSearchParams({
          ...(candidate.rootId ? { thread: candidate.rootId } : {}),
          message: candidate.id,
        })}`,
      );
      notification.close();
    };
  }

  private schedulePublish(
    coordinate: string,
    delay = PUBLISH_DELAY_MS,
    resetAttempts = true,
  ) {
    if (resetAttempts) {
      this.publishAttempts.delete(coordinate);
      this.publishedEventIds.delete(coordinate);
      this.pendingCoordinates.add(coordinate);
    }
    const current = this.publishTimers.get(coordinate);
    if (current) window.clearTimeout(current);
    this.publishTimers.set(
      coordinate,
      window.setTimeout(() => {
        this.publishTimers.delete(coordinate);
        void this.publish(coordinate);
      }, delay),
    );
  }

  private payload(coordinate: string): { topic: string; value: unknown } {
    if (coordinate.startsWith("read-state:")) {
      return {
        topic: "read-state",
        value: {
          v: 1,
          client_id: this.snapshot.clientId,
          contexts: this.snapshot.readContexts,
        },
      };
    }
    if (coordinate === "channel-stars") {
      return {
        topic: coordinate,
        value: {
          version: 1,
          channels: Object.fromEntries(
            Object.entries(this.snapshot.stars).map(([id, entry]) => [
              id,
              { starred: entry.value, updatedAt: entry.updatedAt },
            ]),
          ),
        },
      };
    }
    if (coordinate === "channel-mutes") {
      return {
        topic: coordinate,
        value: {
          version: 1,
          channels: Object.fromEntries(
            Object.entries(this.snapshot.mutes).map(([id, entry]) => [
              id,
              { muted: entry.value, updatedAt: entry.updatedAt },
            ]),
          ),
        },
      };
    }
    if (coordinate === "channel-sections") {
      return {
        topic: coordinate,
        value: {
          version: 1,
          sections: this.snapshot.sections,
          assignments: this.snapshot.assignments,
        },
      };
    }
    return {
      topic: coordinate,
      value: { version: 1, groups: this.snapshot.sort },
    };
  }

  private async publish(coordinate: string) {
    try {
      const credential = await loadSigningCredential(this.pubkey);
      if (!credential)
        throw new Error("Browser signing identity is unavailable");
      const payload = this.payload(coordinate);
      const now = Math.floor(Date.now() / 1_000);
      const createdAt = Math.max(
        now,
        (this.publishCreatedAt.get(coordinate) ?? 0) + 1,
      );
      this.publishCreatedAt.set(coordinate, createdAt);
      const event = makeEncryptedAppDataEvent(
        credential,
        { coordinate, ...payload },
        createdAt,
      );
      this.publishedEventIds.set(coordinate, event.id);
      const response = await fetch("/api/navigation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!response.ok) throw new Error("Navigation preference sync failed");
      this.publishAttempts.delete(coordinate);
      this.commit({ error: null }, false);
    } catch (error) {
      const attempt = (this.publishAttempts.get(coordinate) ?? 0) + 1;
      this.publishAttempts.set(coordinate, attempt);
      this.commit(
        {
          error:
            error instanceof Error
              ? error.message
              : "Navigation preference sync failed",
        },
        false,
      );
      if (attempt <= 3) {
        this.schedulePublish(coordinate, 2_000 * 2 ** (attempt - 1), false);
      }
    }
  }

  markChannelRead(channelId: string) {
    const latest = this.snapshot.candidates
      .filter(
        (candidate) =>
          candidate.channelId === channelId && candidate.rootId === null,
      )
      .at(-1);
    const readContexts = { ...this.snapshot.readContexts };
    if (latest)
      readContexts[channelId] = Math.max(
        readContexts[channelId] ?? 0,
        latest.createdAt,
      );
    const forcedUnread = { ...this.snapshot.forcedUnread };
    delete forcedUnread[channelId];
    this.commit({ readContexts, forcedUnread });
    this.schedulePublish(`read-state:${this.snapshot.clientId}`);
  }

  markChannelUnread(channelId: string) {
    const latest = this.snapshot.candidates
      .filter(
        (candidate) => candidate.channelId === channelId && !candidate.isOwn,
      )
      .at(-1);
    if (!latest) return;
    this.commit({
      forcedUnread: { ...this.snapshot.forcedUnread, [channelId]: latest.id },
    });
  }

  markMessageUnread(channelId: string, messageId: string) {
    if (
      !this.snapshot.candidates.some(
        (candidate) =>
          candidate.channelId === channelId &&
          candidate.id === messageId &&
          !candidate.isOwn,
      )
    ) {
      return;
    }
    this.commit({
      forcedUnread: { ...this.snapshot.forcedUnread, [channelId]: messageId },
    });
  }

  markThreadRead(rootId: string) {
    const latest = this.snapshot.candidates
      .filter((candidate) => candidate.rootId === rootId)
      .at(-1);
    if (!latest) return;
    this.commit({
      readContexts: {
        ...this.snapshot.readContexts,
        [`thread:${rootId}`]: Math.max(
          this.snapshot.readContexts[`thread:${rootId}`] ?? 0,
          latest.createdAt,
        ),
      },
    });
    this.schedulePublish(`read-state:${this.snapshot.clientId}`);
  }

  markMessageRead(messageId: string, createdAt: number) {
    const candidate = this.snapshot.candidates.find(
      (item) => item.id === messageId,
    );
    const forcedUnread = { ...this.snapshot.forcedUnread };
    if (candidate && forcedUnread[candidate.channelId] === messageId) {
      delete forcedUnread[candidate.channelId];
    }
    this.commit({
      readContexts: {
        ...this.snapshot.readContexts,
        [`msg:${messageId}`]: createdAt,
      },
      forcedUnread,
    });
    this.schedulePublish(`read-state:${this.snapshot.clientId}`);
  }

  toggleStar(channelId: string) {
    const current = this.snapshot.stars[channelId]?.value === true;
    this.commit({
      stars: {
        ...this.snapshot.stars,
        [channelId]: { value: !current, updatedAt: Date.now() },
      },
    });
    this.schedulePublish("channel-stars");
  }

  toggleMute(channelId: string) {
    const current = this.snapshot.mutes[channelId]?.value === true;
    this.commit({
      mutes: {
        ...this.snapshot.mutes,
        [channelId]: { value: !current, updatedAt: Date.now() },
      },
    });
    this.schedulePublish("channel-mutes");
  }

  createSection(name: string) {
    const clean = name.trim().slice(0, 60);
    if (!clean) return;
    const id = globalThis.crypto?.randomUUID?.() ?? `section-${Date.now()}`;
    this.commit({
      sections: [
        ...this.snapshot.sections,
        { id, name: clean, order: this.snapshot.sections.length },
      ],
    });
    this.schedulePublish("channel-sections");
  }

  deleteSection(sectionId: string) {
    this.commit({
      sections: this.snapshot.sections.filter(
        (section) => section.id !== sectionId,
      ),
      assignments: Object.fromEntries(
        Object.entries(this.snapshot.assignments).filter(
          ([, id]) => id !== sectionId,
        ),
      ),
    });
    this.schedulePublish("channel-sections");
  }

  moveSection(sectionId: string, direction: -1 | 1) {
    const sections = [...this.snapshot.sections].sort(
      (left, right) => left.order - right.order,
    );
    const index = sections.findIndex((section) => section.id === sectionId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= sections.length) return;
    [sections[index], sections[target]] = [sections[target], sections[index]];
    this.commit({
      sections: sections.map((section, order) => ({ ...section, order })),
    });
    this.schedulePublish("channel-sections");
  }

  assignSection(channelId: string, sectionId: string | null) {
    const assignments = { ...this.snapshot.assignments };
    if (sectionId) assignments[channelId] = sectionId;
    else delete assignments[channelId];
    this.commit({ assignments });
    this.schedulePublish("channel-sections");
  }

  setSort(group: NavigationSortGroup, mode: NavigationSortMode) {
    this.commit({ sort: { ...this.snapshot.sort, [group]: mode } });
    this.schedulePublish("channel-sort");
  }

  setArchivedOpen(open: boolean) {
    this.commit({ archivedOpen: open });
  }

  async enableNotifications(): Promise<boolean> {
    if (typeof Notification === "undefined") return false;
    const permission = await Notification.requestPermission();
    const enabled = permission === "granted";
    this.commit({ notifications: enabled });
    return enabled;
  }

  disableNotifications() {
    this.commit({ notifications: false });
  }
}

const controllers = new Map<string, NavigationController>();

function controllerFor(pubkey: string): NavigationController {
  const key = pubkey.toLowerCase();
  let controller = controllers.get(key);
  if (!controller) {
    controller = new NavigationController(key);
    controllers.set(key, controller);
  }
  return controller;
}

export function useWorkspaceNavigation(
  pubkey: string,
  channels: ChannelView[],
) {
  const controller = controllerFor(pubkey);
  controller.updateChannels(channels);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => EMPTY,
  );
  useEffect(() => controller.start(), [controller]);
  return { snapshot, controller };
}
