# CLAUDE.md

Claude agents should start from `AGENTS.md`.

`AGENTS.md` is the canonical agent entry point for this repository. It covers
the repo map, required reading order, common commands, public-doc constraints,
engineering guardrails, and verification expectations. Do not duplicate those
rules here.

Minimum reminders:

- Read `AGENTS.md` before making changes.
- Do not commit secrets, runtime state, logs, internal identifiers, or local
  absolute paths.
- Do not overwrite unrelated uncommitted user changes.
- Run the relevant verification commands before claiming completion.
