# E2E fixtures

E2E tests target real BIDS data. Tiny / canned fixtures are out of scope (they wouldn't exercise the real pairing and indexing paths); each developer keeps their own copies here, gitignored.

Suggested:

- `aging-brain/` — copy from your `datasets/BrainHealth/AgingBrain/`
- `qa/` — copy from your `datasets/dbic/QA/`

This directory is gitignored alongside `datasets/` so nothing here leaks.
