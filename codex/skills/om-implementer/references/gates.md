# Reading the gates

*A reference for `om-implementer`. The SKILL carries the contract and the hard rules; this file carries the how. If the two ever disagree, the SKILL wins and this one is the bug.*

`biome check` **caps diagnostics silently**. A lint set diffed from the default
output is drawn from roughly **8% of the data**, and a "no new diagnostic on a
touched file" claim built on it is not a measurement — it is a sample presented
as a census.

**Always pass `--max-diagnostics=1000` before diffing sets:**

```bash
bunx biome check . --max-diagnostics=1000 --reporter=summary > lint-after.log 2>&1
```

Measured on T27: the capped run supported a claim the audit then demolished; the
uncapped re-run gave the real answer (248 → 247, identical at rule level, one
diagnostic *deleted*). **That should have been the first measurement, not the
third** — it cost ~25 minutes and two audit passes.


## The gate is a diff, not a pass

Static gates in these repos are **already red on `main`**. A green run is not the bar and is not achievable. The bar is **no NEW failures versus the baseline** captured on the same merge-base before your edits.

So: compare failure **sets**, never counts.

```bash
grep -E "^\(fail\)" run.txt | sed 's/ \[[0-9.]*ms\]$//' | sort > fails.txt
comm -13 fail-baseline.txt fail-after.txt      # must be empty
```

Two traps that make counts lie. Adding a single test file re-partitions the shard split and can move the count on its own — once by 52, from a three-character source change. And the summary `N fail (N confirmed)` is **false** whenever the line above it says `isolation retry skipped`, because in that case nothing was confirmed in isolation. Read that line first.

