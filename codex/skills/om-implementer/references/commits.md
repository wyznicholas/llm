# Commits

*A reference for `om-implementer`. The SKILL carries the contract and the hard rules; this file carries the how. If the two ever disagree, the SKILL wins and this one is the bug.*

Write commit bodies with **actual line breaks**, never the two characters `\` and `n`. Passing an escaped `\n` through to `git commit -m` embeds it literally, and someone then has to rewrite history by hand to fix it. This has happened twice and both times cost a `git filter-branch` and an explanation in the shipping report.

Use a heredoc or a file rather than an inline `-m` with escapes:

```bash
git commit -F - <<'EOF'
fix(scope): one-line summary in the imperative

Why this change, in prose. Name any shared files touched.
EOF
```

