# Train surfaces

*The list `train.ts` reads. One key is one batch PR (`train/<key>`). Why trains exist, and the commands: [[kanban/references/trains|trains]].*

*From 2026-09-28 the web keys ship to
`gitlab.com/openmarketxyz/frontend/openmarket-chat` MRs. Keys prefixed
`openmarket-internal-` stay on GitHub. Keys prefixed `mobile-` are
`openmarket-chat-app` on GitLab.*

**Edit this list freely.** Add a key by adding a line in exactly the shape below — a backticked lowercase-kebab key, an em dash, and what the surface covers. `train.ts ship` refuses a key that is not listed, so a typo (`sidebars`) cannot quietly start a second train; a genuinely new surface is either added here or passed once as `--new-surface "<what it covers>"`, which appends the line for you.

Pick the key by **the file most of the diff lives in**, not by where the symptom was noticed. The point of a train is that PRs on the same files stop conflicting with each other, so the surface is a file boundary first and a product boundary second.

- `sidebar` — channel list, categories, channel drag and drop, unread badges in the list
- `create-channel` — the Create channel dialog and its summaries
- `peek` — DM and channel peek popovers
- `test-infra` — tests, ratchets, harness and CI changes with no product surface
- `doc-library` — the Library panel and view, doc history, the doc context menu, the editor
- `doc-pane` — the doc pane itself: docked and floating layout, outline, header icons, paging
- `agents-dialogs` — the agents panel, Your agents and Invite agent dialogs
- `channel-settings-topics` — Channel Settings dials, the topics list and its empty states
- `browse-channels` — the Browse channels view, its jump field and sort chips
- `rail-shell` — the server rail, `Shell.tsx` layout, the top bar
- `right-panel-mobile` — right-hand panels and the phone-breakpoint layouts
- `settings` — user and app settings outside Channel Settings
- `messages` — the message list, composer, threads, replies, reactions
- `misc` — a fix that genuinely fits no surface above; prefer adding a real key
- `agent-center` — the Agent Center pane (#/agents): its header, lanes, roster search, fleet cards and doors
- `om-tape` — the om turn tape (AgentPane.tsx): the #/agent landing, turn rows, and tape scroll and pin behaviour

## Mobile

*Added 2026-09-20. Until now every key above was web/desktop, so a `#mobile` fix
had no key to ship to — `train.ts ship` refuses an unlisted surface, and twelve
mobile cards reached `Review` one card at a time as a result. These keys are
derived from the files the stranded cards actually name, not from their titles:
`MobileStyle.swift` (native) and `row.tsx` (React Native) are two different
restyle tracks, and one key over both would serialise work that never collides.*

*Restyle is ONE train (Nicholas, 2026-09-21).* The 09-20 split into
`mobile-style` / `mobile-row` / `mobile-appearance` / `mobile-icons` is **retired**:
it followed the file-boundary rule literally, and the restyle still reached review
as eleven separate MRs. Nicholas: "group them all together for the mobile redesign, into
one MR, don't make it that fragmented." For the redesign, the **product boundary
beats the file boundary**. Every restyle ref ships to `mobile-redesign`, even when
that serialises two tracks that don't collide. A restyle card counts as restyle by
the definition in the `mobile restyle is all #high` rule (visual layer only; parity, calls, links and
bug follow-ups are not restyle).

*Known hot file: `dm-screen.tsx` is touched by `mobile-net`, `mobile-composer`
and `mobile-dm-fixture`. Those three trains can conflict with each other; ship
the smallest one first rather than adding a fourth key for the overlap.*

- `mobile-redesign` — **the whole OpenFloor redesign/restyle, one train** (Nicholas, 2026-09-21): every visual-layer change, whichever file it lands in — palettes and theme (`theme.ts`, `theme-context.tsx`, `appearance-context.tsx`, `app.json`, splash colorsets, `AppearanceModule.kt`), type and shape, the Row/chip/empty-state/IconButton primitives and the screens adopting them (`row.tsx`, `settings-list.tsx`, `chip.tsx`, `empty-state.tsx`, library/docs/activity/follow screens), icons and the tab bar (`icon.tsx`, `bottom-tabs*.tsx`), the Swift restyle set (`MobileStyle.swift` and siblings), composer chrome, launch chrome, and `DESIGN_SYSTEM.md` / scope-record docs. Composer *features* stay on `mobile-composer`
- `mobile-composer` — the native composer: `OpenFloorComposerView.swift`, `OpenFloorComposerView.kt`, `native-composer-editor.tsx`
- `mobile-links` — invite and deep links: `chat-href.ts`, `chat-link.ts`, `AndroidManifest.xml` intent filters, link survival across sign-in
- `mobile-dm-fixture` — the `__DEV__` DM fixture route and its probes: `canvas-probe.tsx` and the `dm-screen.tsx` fixture doors
- `mobile-moderation` — moderation and server management screens: `member-sheet.tsx`, `moderation-copy.ts`, `moderation-restrictions.ts`, `server-management-screen.tsx`
- `mobile-net` — transport backoff and refusal handling: `backoff-429.ts` and its callers
- `openmarket-internal-test-infra` — openmarket-internal: tests, fakes, ratchets, harness and CI changes with no product surface
- `openmarket-internal-notis` — openmarket-internal: the notification inbox — notis capture and its event-to-notice composition (packages/cli/src/runner/notis-events.ts), the notis store and the /notis panel
- `composer-pills` — the composer pill layer: composer-pills.ts — chip recognition, draft bindings (topic/role/library/share-link), chip painting in the draft
- `openmarket-internal-rooms-client` — openmarket-internal: packages/rooms-client source (the published @openmarket/rooms-client) — link and reference grammar, view-models, client
- `invites` — invite links, their settings dialog, Server Settings → Invites, and the join-with-link path
- `openmarket-internal-daemon-http` — openmarket-internal: daemon HTTP routes in packages/cli/src/runner/http — the rooms-routes registrar, its auth and operator-proof gates, and the daemon GUI APIs (import, library, librarian, away, tones)
- `mobile-calls` — OpenFloor calls: incoming ring (Android notification, iOS CallKit/PushKit), `call-ring-notification*`, `modules/openfloor-callkit`, the call push presentation and its answer/decline bridge. While F94 !92 / F156 !98 are unmerged this train stacks on F156's branch (added by F143, 2026-09-25)
- `search` — message search: SearchBar.tsx, SearchPanel.tsx, search-seam.ts, search-query.ts, search-history.ts, tag-search
- `archive-modal` — The Archive modal (channels + docs tabs, pick-row doc selection, restore/purge)
- `kiyotaka-frontend-watchlist` — kiyotaka-frontend: the watchlist — useWatchlist and its sibling composables, the watchlist store and API service, Watchlist.vue and the mobile watchlist
- `landing-app-links` — kiyotaka-landing-page-v2: the .well-known association files (apple-app-site-association, assetlinks.json) that decide which openmarket.xyz links open OpenFloor
- `mobile-snackbar` — the global error Snackbar and its dismiss/dedupe logic: snackbar.tsx, snackbar-queue.ts, and its __DEV__ probe door
- `mobile-build-guard` — Metro/build-config guards that keep __DEV__-only code out of production builds: metro.config.js, its blockList, and structural tests asserting against bundle drift
- `mobile-notifications` — OpenFloor push notification presentation: OpenFloorNotificationsService.kt (Android presenter/handling delegates), src/push/*, docs/PUSH_NOTIFICATIONS.md
- `mobile-charts` — the OpenMarket mobile charts app, `kiyotaka-frontend-app` on GitLab (gitlab.com/openmarketxyz/frontend/kiyotaka-frontend-app): symbol dialog, venues, watchlists, Polymarket search, its chat. Added 2026-10-02 for the ⌗ mobile topic to-dos
- `mobile-charts-web-port` — kiyotaka-frontend-app: ports of web `kiyotaka-frontend` `production` changes filed by web-port-scout (`#web-port` cards). The owner rebases and squash-merges each train MR as soon as its verifier passes (ff-only project, no CI), so it carries one port, occasionally two. Added 2026-10-08
