#!/bin/bash
# THE audit stamp marker. Defined here once, sourced by both the writer
# (stamp.sh) and the reader (slice-filter.sh).
#
# Why this file exists: Phase 0 specified the stamp's format in the audit-note
# convention and the check for it in the slice instruction. They disagreed
# immediately — the writer emitted "**Audited** " and the reader looked for a
# YAML "audited:" key that existed in none of the 103 files. Every audited
# feature was re-picked forever and the burn-down never advanced, silently.
# Never inline this string anywhere.
AUDIT_MARK='**Audited** '
export AUDIT_MARK
