# kudos — appreciation posts in #special-mentions

Three times a week (Mon / Wed / Fri) this routine picks one teammate who has
done a lot of work over the last 14 days but has not been thanked much for
it, and posts a specific thank-you in OM Chat #special-mentions as **@om-agent**
(#dev-forums until 2026-10-21).
Every day it also watches the public Discord's announcement channel: when
something ships, it thanks the people who built it. OM Chat's #announcements
is not watched for launches.

The point is morale: a lot of good work here merges with nobody saying
anything. The bot says it, with one or two real numbers about who the work
helped.

## How a weekly pick is made

1. **Collect** (`gitlab.ts`, `chat.ts`): every MR merged in the window across
   all `openmarketxyz` projects (one paginated group call), notes on those MRs
   from people other than the author, and @mentions in the openmarket space's
   rooms.
2. **Count** (`stats.ts`), per person. Production cherry-picks and bot MRs
   are dropped first, so a fix shipped to main and production counts once.
   - effort: merged MRs, repos touched, active days, fixes shipped, issues
     closed, hard MRs (commits on ≥ 3 different days; an MR just left open
     doesn't count), most commit-days on one MR
   - recognition: notes from others, upvotes, chat mentions, PIC callouts
     in #announcements
3. **Pick** (`score.ts`): rank everyone against the team on effort and on
   recognition, then take the eligible person with the widest
   effort-over-recognition gap. Ranking by position means one huge number
   can't drown out the rest.
4. **Write** (`writer.ts` + `PROMPT.md`): a headless `claude -p` run finds
   one or two impact numbers in PostHog (product surfaces) or ore's Loki /
   Prometheus (backend) and drafts the post. Every number has to come from a
   query it ran; the draft lists each claim with its source.
5. **Check and send** (`post.ts`): the draft is refused if it is too long, has
   a mass mention, misses the person's tag, or tags anyone unknown or
   excluded. Otherwise it goes over ssh to `routine-say.ts` on oms-mac-mini.

## Why the writer is locked down

The writer reads MR titles, MR descriptions and announcement text, which
anyone who can open an MR can write. So it is treated as something that can
be talked into things:

- `--restricted` ignores the operator's settings files (their `defaultMode` is
  `bypassPermissions`) and refuses that mode; `--strict-mcp-config` with no
  config loads no MCP servers, so trading, mail and chat tools are out of reach.
- Its only tool is `kudos-fetch.ts`, which makes reads only: GETs to GitLab
  (through `glab`), ore Loki and ore Prometheus, plus PostHog's read-only HogQL
  endpoint. It refuses flags and unknown paths.
- Its environment holds no secrets; `kudos-fetch` reads the PostHog key itself.
- The evidence is inlined in the prompt between markers, labelled as data.
- `post.ts` refuses a draft that links anywhere other than
  gitlab.com/openmarketxyz or openmarket.xyz, mass-mentions, or tags someone
  unknown or excluded. The model never sends anything itself.

Who is never picked:
- anyone in `people.json` `exclude` (Kyle)
- anyone holding the space's **@QA** role, read live on every run (the run
  stops if that role can't be read)
- bots
- anyone thanked by a weekly post in the last 14 days (launch posts don't count)
- anyone with no OM Chat handle in `people.json`, since the post couldn't tag them

## Running it

```bash
bun tools/kudos/run.ts --dry-run --weekly   # draft only; see ~/.local/state/kudos/drafts/
tools/kudos/install.sh --load               # copy to ~/.local/share/kudos + launchd 10:15 daily
touch ~/.local/state/kudos/PAUSED           # kill switch
```

Each run writes `drafts/<date>-ranking.md` (the whole team's numbers) and
`drafts/<date>-weekly-<handle>.md` (the post plus every fact's source), so a
surprising pick or number can always be traced.

It runs on the operator's Mac, not on oms-mac-mini, because ore's Loki and
Prometheus only answer from this network. It is installed outside
`~/Documents` because launchd can't reliably read files under it.

## Optional sources

- **PostHog** (`~/.config/kudos/posthog.env`): `POSTHOG_PERSONAL_API_KEY`,
  `POSTHOG_PROJECT_ID` (Kiyotaka = 234431) and `POSTHOG_HOST=https://us.posthog.com`
  (the project is on the US cloud; the EU host answers 401). The writer counts
  `feature:*` events by `properties.feature`, distinct users and page views.
- **Sentry** (`~/.config/kudos/sentry.env`): `SENTRY_TOKEN`, `SENTRY_HOST=https://de.sentry.io`,
  `SENTRY_ORG=trontal-group`. Issue lists and single issues only (counts, users,
  first/last seen); event bodies are refused because they carry user data.
- **Grafana** (`~/.config/kudos/grafana.env`): `GRAFANA_TOKEN`,
  `GRAFANA_HOST=https://grafana.occ.kiyotaka.dev`. Proxies Loki and Prometheus for
  the main cluster (tharamine / user-service, unreachable directly) and for ore,
  blk and cme, by datasource name.

All three files are chmod 600 and read only by `kudos-fetch`, never by the writer
model. A source whose file is missing is simply skipped.

**Statistics.** Every post should carry at least one real number. The writer must
try three queries across sources before giving up, and says why in
`noStatsReason` if nothing fits. A draft without numbers gets one more, pointed
attempt (`draftWithStats`). A number is never invented, so a post can still go
out without one; the draft file records why.
- **Public Discord launches** (`discord.ts`): the operator isn't an admin on
  the public OpenMarket server, so its announcement channel is **Followed**
  into `#om-launches` on a server the operator owns, and a read-only bot
  there (View Channels + Read Message History) reads the copies. Only webhook
  posts (the Followed copies) count, not people chatting in that channel.
  Reactions on the original aren't copied, so they aren't available.
  Config: `~/.config/kudos/discord.env` (chmod 600) with `DISCORD_BOT_TOKEN`
  and `DISCORD_CHANNEL_ID`. The writer sees the last 14 days of launches
  already thanked, so a re-posted announcement is not thanked twice.
