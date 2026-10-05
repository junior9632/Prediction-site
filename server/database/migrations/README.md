# Versioned migrations

`schema.sql` is the **baseline**: fully idempotent (`CREATE TABLE IF NOT EXISTS`),
safe to re-apply on every deploy, and the single source of truth for a **fresh**
database.

Everything that changes an **existing live** database afterwards goes here as a
numbered SQL file, applied exactly once in order by `npm run db:migrate` and
recorded in the `schema_migrations` table.

## Rules

1. **Name**: `NNN-short-description.sql` — three-digit sequence, dash separator.
   Example: `001-add-ticket-notified-at.sql`.
2. **Never edit an applied migration.** The runner stores a SHA-256 checksum and
   warns loudly when an applied file changed. Write a new migration instead.
3. **Keep `schema.sql` in sync.** A migration alters live databases; the same
   change must also appear in `schema.sql` so fresh installs get it from the
   baseline. (`npm run test:sql` checks the schema against every query.)
4. **MySQL 5.7 / MariaDB 10.3 compatible SQL only** — the production target is
   cPanel shared hosting. No `ALTER TABLE ... IF NOT EXISTS` (MySQL doesn't
   support it), no features newer than the supported engines.
5. One concern per file. Small migrations are easy to review and easy to roll
   forward from.

## Commands

```bash
npm run db:migrate              # baseline + all pending migrations
npm run db:migrate -- --status  # show applied/pending without touching anything
```

## Example

`001-add-ticket-notified-at.sql`:

```sql
-- Adds the timestamp of the outbound notification for a published ticket.
ALTER TABLE `tickets`
  ADD COLUMN `notified_at` DATETIME NULL AFTER `settled_at`;
```
