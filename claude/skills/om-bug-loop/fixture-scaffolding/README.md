# Cloud-fork evidence harness (shared)

A vite harness that mounts a real component with the app's real stylesheets, for the
**`openmarket-chat-cloud`** fork where `bun run build` fails on `main` (a `@bufbuild/protobuf`
pin against an installed 1.10.1, plus the private `@orangecharts` package) and there is
therefore **no servable bundle to photograph**.

Origin: written for T14 (`cloud-port-connections-dropdown`). It lived inside that task's
evidence directory, where the next task could not see it — so T35 wrote its own from scratch
(~35 min, and its harness omitted the token stylesheets, producing six captures with no
tooltip in them), and T36 rediscovered the same two fixes by hand (~6 min). Moved here
2026-09-04 so it is found before it is rewritten.

## The two fixes that are not obvious

- **`root: dirname`** in `vite.harness.config.ts`.
- **`@source "../src";`** in `harness.css` — a harness rooted at `harness/` makes Tailwind v4
  skip `src/`, so a skeleton renders 0x0 and the "before" shot looks like a blank panel.
  T36 caught this only by viewing the image. **View every capture before banking it**,
  including the ones you expect to be boring.

## Use

Copy these four files into your worktree's `harness/`, point `harness.tsx` at the component
under test, and run two dev servers (one per arm, ~15s each). Do not try to fix the cloud
`main` build; report `check:dist` as a **GAP, not a pass**, because it is red on both arms and
on untouched `main`.
