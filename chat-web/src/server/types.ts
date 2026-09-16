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
  author: ProfileView;
  content: string;
  createdAt: number;
  editedAt: number | null;
  isOwn: boolean;
  replyCount: number;
  lastReplyAt: number | null;
  reactions: ReactionView[];
};

export type ThreadView = {
  rootId: string;
  root: MessageView | null;
  replies: MessageView[];
};

export type WorkspaceView = {
  identity: ProfileView;
  channels: ChannelView[];
  selectedChannel: ChannelView;
  timeline: MessageView[];
  thread: ThreadView | null;
  generatedAt: number;
};

export type ChannelSnapshot = Pick<
  WorkspaceView,
  "selectedChannel" | "timeline" | "thread" | "generatedAt"
> & {
  revision: string;
};
