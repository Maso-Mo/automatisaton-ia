import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { contentItems, contentVersions } from './editorial';
import { platformAccounts, publications } from './publishing';
import { projects } from './projects';
import { jobs } from './system';

/**
 * Le calendrier est une intention humaine persistée. La publication porte
 * l'état distant et le job porte l'exécution ; le créneau ne les remplace pas.
 */
export const calendarSlots = sqliteTable(
  'calendar_slots',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    content_item_id: text()
      .notNull()
      .references(() => contentItems.id),
    content_version_id: text()
      .notNull()
      .references(() => contentVersions.id),
    platform_account_id: text()
      .notNull()
      .references(() => platformAccounts.id),
    platform: text().notNull(),
    scheduled_for: integer().notNull(),
    timezone: text().notNull(),
    rigidity: text().notNull(),
    status: text().notNull().default('draft'),
    publication_id: text().references(() => publications.id),
    job_id: text().references(() => jobs.id),
    missed_reason: text(),
    cancelled_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index('idx_calendar_range').on(table.scheduled_for, table.status),
    index('idx_calendar_account').on(table.platform_account_id, table.scheduled_for),
    index('idx_calendar_project').on(table.project_id, table.scheduled_for),
    index('idx_calendar_publication').on(table.publication_id),
    check('chk_calendar_rigidity', sql`${table.rigidity} in ('LOCKED','FLEXIBLE','EVERGREEN')`),
    check(
      'chk_calendar_status',
      sql`${table.status} in ('draft','scheduled','due','publishing','published','manual_required','cancelled','missed','failed')`,
    ),
  ],
);

/** Proposition seulement : aucune ligne ici ne déplace un créneau sans acceptation. */
export const calendarChangeProposals = sqliteTable(
  'calendar_change_proposals',
  {
    id: text().primaryKey(),
    calendar_slot_id: text()
      .notNull()
      .references(() => calendarSlots.id),
    proposed_scheduled_for: integer(),
    proposed_timezone: text(),
    proposed_rigidity: text(),
    reason: text().notNull(),
    status: text().notNull().default('pending'),
    proposed_at: integer().notNull(),
    resolved_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index('idx_calendar_proposals_slot').on(table.calendar_slot_id, table.status),
    check(
      'chk_calendar_proposal_status',
      sql`${table.status} in ('pending','accepted','rejected')`,
    ),
    check(
      'chk_calendar_proposal_rigidity',
      sql`${table.proposed_rigidity} is null or ${table.proposed_rigidity} in ('LOCKED','FLEXIBLE','EVERGREEN')`,
    ),
  ],
);
