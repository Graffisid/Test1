# Schema (human-readable)

This file will be filled in during Phase 1 (system of record). The plan's
Phase 1 tables are:

`customers`, `ads`, `ad_variants`, `comments`, `leads`, `calls`,
`appointments`, `approvals`, `metrics`, `signals`, `agent_activity_log`

Every table gets `id`, `created_at`, and `updated_at`. Every outbound-action
table gets an `idempotency_key` with a unique constraint.
