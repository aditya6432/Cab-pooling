-- =====================================================================
-- PoolUp — 00_reset.sql   (runs first; owned by Member 1)
-- ---------------------------------------------------------------------
-- Rebuilds the whole database from scratch, so `npm run db:setup` is
-- reproducible on any machine. File order (see server/scripts/setup-db.js):
--
--   00        reset + extensions
--   10 – 16   TABLES        M1 users/rides · M2 booking · M3 expenses ·
--                           M4 payments (+ state-machine data) · M5 ratings (+ tags)
--   20 – 24   LOGIC         triggers + stored functions, one file per module
--   30 – 34   VIEWS         incl. M5's materialized view
--   40 – 44   INDEXES       each justified by a query or workflow
--   50        INTEGRATION   cross-module views / consistency checks
--   queries/  named, read-only SQL served to the "SQL library" (not run here)
--
-- All tables are created before any logic so that SQL-language functions,
-- which PostgreSQL validates at CREATE time, can reference every module.
-- =====================================================================
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

-- GiST support for "=" on scalar types (M4's EXCLUDE reminder rate limit)
CREATE EXTENSION IF NOT EXISTS btree_gist;
