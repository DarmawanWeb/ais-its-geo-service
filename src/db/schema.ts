// Drizzle definitions of the "geo" schema (docs/PLATFORM_SPEC.md §6).
// The SQL files in migrations/ create the tables; these definitions MUST
// mirror them and only type the queries.
import { ZONE_KINDS } from '@darmawanweb/ais-its-contracts/domain';
import { geography } from '@darmawanweb/ais-its-nest/db';
import { sql } from 'drizzle-orm';
import * as pg from 'drizzle-orm/pg-core';

/** The service's PostgreSQL schema, owned by the role `geo_svc`. */
export const serviceSchema = pg.pgSchema('geo');

/** Zones and geofences (`0001_init.sql`); `org_id` NULL = global zone. */
export const zones = serviceSchema.table(
  'zones',
  {
    id: pg.uuid('id').primaryKey(),
    orgId: pg.uuid('org_id'),
    code: pg.text('code').notNull(),
    name: pg.text('name').notNull(),
    kind: pg.text('kind', { enum: ZONE_KINDS }).notNull(),
    geom: geography('geom', { subtype: 'Geometry' }).notNull(),
    bufferM: pg.doublePrecision('buffer_m').notNull().default(0),
    alertOnEnter: pg.boolean('alert_on_enter').notNull().default(false),
    active: pg.boolean('active').notNull().default(true),
    properties: pg
      .jsonb('properties')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    source: pg.text('source'),
    createdBy: pg.uuid('created_by'),
    createdAt: pg
      .timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: pg
      .timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pg
      .unique('zones_org_code_key')
      .on(table.orgId, table.code)
      .nullsNotDistinct(),
    pg.index('zones_geom_gist').using('gist', sql`(${table.geom}::geometry)`),
    pg.index('zones_org_kind_idx').on(table.orgId, table.kind),
    pg.index('zones_kind_active_idx').on(table.kind, table.active),
  ],
);

/** Transactional outbox (`0001_init.sql`), published by `GeoOutboxRelay`. */
export const outbox = serviceSchema.table(
  'outbox',
  {
    id: pg.uuid('id').primaryKey(),
    seq: pg.bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    type: pg.text('type').notNull(),
    entityKey: pg.text('entity_key'),
    orderingKey: pg
      .text('ordering_key')
      .generatedAlwaysAs(
        sql`split_part(type, '.', 1) || ':' || coalesce(entity_key, id::text)`,
      ),
    data: pg.jsonb('data').notNull(),
    createdAt: pg
      .timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    attempts: pg.integer('attempts').notNull().default(0),
    lastError: pg.text('last_error'),
    nextAttemptAt: pg.timestamp('next_attempt_at', { withTimezone: true }),
    publishedAt: pg.timestamp('published_at', { withTimezone: true }),
    failedAt: pg.timestamp('failed_at', { withTimezone: true }),
  },
  (table) => [
    pg.unique('outbox_seq_key').on(table.seq),
    pg
      .index('outbox_pending_key_idx')
      .on(table.orderingKey, table.seq)
      .where(sql`published_at IS NULL AND failed_at IS NULL`),
    pg
      .index('outbox_pending_seq_idx')
      .on(table.seq)
      .where(sql`published_at IS NULL AND failed_at IS NULL`),
    pg
      .index('outbox_published_at_idx')
      .on(table.publishedAt)
      .where(sql`published_at IS NOT NULL`),
  ],
);

/** `geometry(Geometry,4326)` column of the tiles view (values: EWKB hex). */
const geometry = pg.customType<{ data: string; driverData: string }>({
  dataType: () => 'geometry(Geometry,4326)',
});

/**
 * Global active zones for Martin (`tiles_ro`), geometry instead of geography;
 * a `security_barrier` view created by `0001_init.sql` (never queried here).
 */
export const zonesTiles = serviceSchema
  .view('zones_tiles', {
    id: pg.uuid('id').notNull(),
    code: pg.text('code').notNull(),
    name: pg.text('name').notNull(),
    kind: pg.text('kind', { enum: ZONE_KINDS }).notNull(),
    bufferM: pg.doublePrecision('buffer_m').notNull(),
    alertOnEnter: pg.boolean('alert_on_enter').notNull(),
    updatedAt: pg.timestamp('updated_at', { withTimezone: true }).notNull(),
    geom: geometry('geom').notNull(),
  })
  .existing();
