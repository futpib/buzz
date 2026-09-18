import type { ViewCacheState } from "@/server/view-cache";

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type ProfileView = {
  pubkey: string;
  name: string;
  picture: string | null;
  initials: string;
  color: string;
};

export type ChannelView = {
  id: string;
  name: string;
  description: string;
  type: "stream" | "forum" | "dm" | "workflow";
  visibility: "public" | "private" | null;
  archived: boolean;
};

export type ReactionView = {
  emoji: string;
  count: number;
  reactedByMe: boolean;
};

export type MessageView = {
  id: string;
  threadRootId: string | null;
  parentId: string | null;
  author: ProfileView;
  content: string;
  createdAt: number;
  editedAt: number | null;
  isOwn: boolean;
  replyCount: number;
  lastReplyAt: number | null;
  replyParticipants: ProfileView[];
  reactions: ReactionView[];
};

export type ChannelTimelineCursor = {
  createdAt: number;
  id: string;
};

export type ChannelHistoryPage = {
  messages: MessageView[];
  hasMore: boolean;
  nextCursor: ChannelTimelineCursor | null;
  generatedAt: number;
  cacheState: ViewCacheState;
};

export type ThreadView = {
  rootId: string;
  outerRootId: string;
  root: MessageView | null;
  replies: MessageView[];
};

export type ThreadSummaryView = {
  channel: ChannelView;
  root: MessageView;
  activityAt: number;
};

export type ThreadsWorkspaceView = {
  identity: ProfileView;
  channels: ChannelView[];
  threads: ThreadSummaryView[];
  generatedAt: number;
  cacheState: ViewCacheState;
};

export type InboxCategory = "mention" | "needs_action" | "thread";

export type InboxItemView = {
  id: string;
  conversationId: string;
  channel: ChannelView | null;
  threadId: string | null;
  author: ProfileView;
  content: string;
  createdAt: number;
  categories: InboxCategory[];
  itemCount: number;
};

export type InboxWorkspaceView = {
  identity: ProfileView;
  channels: ChannelView[];
  items: InboxItemView[];
  generatedAt: number;
  cacheState: ViewCacheState;
};

export type SentItemView = {
  id: string;
  channel: ChannelView;
  threadId: string;
  message: MessageView;
};

export type SentWorkspaceView = {
  identity: ProfileView;
  channels: ChannelView[];
  items: SentItemView[];
  generatedAt: number;
  cacheState: ViewCacheState;
};

export type WorkspaceView = {
  identity: ProfileView;
  channels: ChannelView[];
  selectedChannel: ChannelView;
  timeline: MessageView[];
  timelineHasMore: boolean;
  timelineCursor: ChannelTimelineCursor | null;
  thread: ThreadView | null;
  generatedAt: number;
  cacheState: ViewCacheState;
};

export type ChannelSnapshot = Pick<
  WorkspaceView,
  | "selectedChannel"
  | "timeline"
  | "timelineHasMore"
  | "timelineCursor"
  | "thread"
  | "generatedAt"
> & {
  revision: string;
};

export type TypingIndicatorView = {
  pubkey: string;
  threadHeadId: string | null;
  createdAt: number;
};

export type SearchResultView = {
  id: string;
  channelId: string;
  channelName: string;
  threadId: string;
  author: ProfileView;
  content: string;
  createdAt: number;
  isOwn: boolean;
};

export type SearchView = {
  query: string;
  results: SearchResultView[];
  generatedAt: number;
  cacheState: ViewCacheState;
};
