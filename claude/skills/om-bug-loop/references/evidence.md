# Evidence and paperwork

*A reference for `om-task`. The agent file carries the contract and the decision rules; this file carries the how. If the two ever disagree, the agent file wins and this one is the bug.*

**Provenance is written by a tool now, not by hand.** Nineteen of ~24 audit
FAILs were one shape — a figure with no artifact, an artifact with no arm, a
capture not tied to a commit. Stamp as you go:

```bash
bun ~/.claude/skills/om-bug-loop/scripts/stamp.ts write <file> --arm before|after --commit <sha> [--asset v=…]
bun ~/.claude/skills/om-bug-loop/scripts/stamp.ts figure "lint-after" --file lint-after.log --value "247 diagnostics, uncapped"
```

Then, **before you report**, run the half that matters:

```bash
bun ~/.claude/skills/om-bug-loop/scripts/stamp.ts manifest "$EVIDENCE" --strict
```

It writes `MANIFEST.md` and **names every artifact with no provenance**. Fix
those before anyone else finds them; that is the whole failure class, discharged
by a command instead of by remembering.

