-- 0003_outbox_kit_relay — the outbox of the kit's per-key OutboxRelay
-- (@darmawanweb/ais-its-nest 0.3), which replaces the service's own relay.
--
-- Same conventions as 0001_init.sql: runs inside the service schema as geo_svc
-- in one transaction, unqualified names, forward-only (never edit once applied).
--
-- outbox already has seq (identity, insertion order) and next_attempt_at
-- (0001_init.sql), so the kit relay detects per-key mode: every replica claims
-- due rows with FOR UPDATE SKIP LOCKED and publishes the rows of one entity_key
-- (the zone id of zone events and of their audit records) in seq order; a failed
-- row backs off on its own (next_attempt_at) and only its key waits. These are
-- the indexes of the kit's outboxUpgradeSql() (its column statements are no-ops
-- for this table). The head-of-line index of the former relay is dropped first:
-- it holds the kit's index name outbox_pending_key_idx, on ordering_key.
--
-- ordering_key is no longer read: the kit orders by entity_key, which is
-- stricter (a zone's snapshots, tombstone and audit records form one key). The
-- generated column stays for one release, so that a 0.1 replica (rolling update
-- or rollback) can still relay; a later migration drops it.

DROP INDEX IF EXISTS outbox_pending_key_idx;

-- Pending rows by age (oldest-pending gauge; serial mode order).
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (created_at, id)
  WHERE published_at IS NULL AND failed_at IS NULL;
-- Pending rows in insertion order (the relay's claim order; exists since 0001).
CREATE INDEX IF NOT EXISTS outbox_pending_seq_idx ON outbox (seq)
  WHERE published_at IS NULL AND failed_at IS NULL;
-- The previous pending row of a key (per-key runs).
CREATE INDEX IF NOT EXISTS outbox_pending_key_idx ON outbox (entity_key, seq)
  WHERE published_at IS NULL AND failed_at IS NULL;
-- Older rows of a key that wait for their retry (the key waits behind them).
CREATE INDEX IF NOT EXISTS outbox_retry_idx ON outbox (entity_key, seq)
  WHERE published_at IS NULL AND failed_at IS NULL AND next_attempt_at IS NOT NULL;
-- Parked rows (aisits_outbox_failed_rows).
CREATE INDEX IF NOT EXISTS outbox_failed_idx ON outbox (failed_at)
  WHERE failed_at IS NOT NULL;

COMMENT ON TABLE outbox IS
  'Transactional outbox of the GEO and AUDIT events (kit OutboxRelay, per-key mode: FOR UPDATE SKIP LOCKED, entity_key order by seq).';
COMMENT ON COLUMN outbox.ordering_key IS
  'Deprecated since 0.2.0 (read only by the 0.1 relay); dropped by a later migration.';
