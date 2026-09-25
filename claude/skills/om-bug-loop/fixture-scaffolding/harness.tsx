import "./harness.css";
import "../src/shared/tokens.css";
import "../src/shared/tokens-compat.css";
import "../src/shared/ui/ui.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { FriendsPane } from "../src/components/FriendsPane";

const names = new Map<string, string>([
  ["u-mutual", "maya"],
  ["u-follower", "omar"],
  ["u-following", "zed"],
]);
const listeners = new Set<() => void>();
let version = 0;

const base: Record<string, unknown> = {
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  getVersion: () => version,
  auth: { userId: "me", username: "me", handle: "me" },
  active: { kind: "friends" },
  rooms: new Map(),
  topics: { inboxFor: () => null },
  friendsPokeGen: 0,
  followingIds: new Set(["u-mutual", "u-following"]),
  followerIds: new Set(["u-mutual", "u-follower"]),
  mutualIds: new Set(["u-mutual"]),
  followersVisibility: null,
  followersTotal: null,
  pendingIncomingRequests: [],
  pendingOutgoingRequests: [],
  outgoingRequestsComplete: true,
  pendingFriendRequests: 0,
  blocks: { rows: [], hasMore: false, loading: false },
  ensureConnectionsLoaded: async () => {},
  ensureBlocksLoaded: async () => {},
  resolveBlockedIdentities: async () => {},
  isResolvingBlockedIdentity: () => false,
  isResolvingConnectionIdentity: () => false,
  isBlockedUser: () => false,
  resolveConnectionIdentities: async () => {},
  cachedUsername: (id: string) => names.get(id),
  presenceOf: () => ({
    state: "unknown",
    source: "unknown",
    observedAt: null,
    since: null,
    expiresAt: null,
    platform: null,
  }),
  liveMemberFor: () => null,
  profileFor: () => null,
  openFriends: (tab?: string) => {
    base.active = tab && tab !== "connections" ? { kind: "friends", tab } : { kind: "friends" };
    version += 1;
    for (const l of listeners) l();
  },
  requestSettings: () => {},
  openDm: async () => null,
  openProfileCard: () => {},
  openConfirm: () => {},
  confirmBlockUserById: () => {},
  unblockUserById: async () => {},
  loadMoreBlocks: async () => {},
  toast: () => {},
  follow: async () => "following",
  unfollow: async () => true,
  acceptFollowRequest: async () => true,
  denyFollowRequest: async () => true,
  cancelFollowRequest: async () => true,
  acceptAllFollowRequests: async () => 2,
  removeFollower: async () => true,
};

// Mirror the real call site's wrapper (ChatPane.tsx: the friends branch
// renders FriendsPane inside `flex-1 flex min-h-0 min-w-0`), so the pane gets
// the same column layout and full-width rows it has in the app.
createRoot(document.getElementById("root") as HTMLElement).render(
  createElement(
    "div",
    { style: { display: "flex", height: "100vh", width: "100vw" } },
    createElement(
      "div",
      { className: "flex-1 flex min-h-0 min-w-0" },
      createElement(FriendsPane, { session: base as never }),
    ),
  ),
);
