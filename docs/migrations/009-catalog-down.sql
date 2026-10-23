-- Optional schema rollback AFTER restoring catalog data using the application
-- rollback command and stopping all feature workers. Run with ON_ERROR_STOP.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('workspace.commands', 0));
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM integration.import_batches WHERE status IN ('running','completed')) THEN
  RAISE EXCEPTION 'Rollback completed catalog imports and stop workers before schema rollback';
 END IF;
END $$;
-- This removes saved recovery evidence: retain an export if it is still needed.
DROP TABLE integration.import_batches;
DELETE FROM integration.schema_migrations WHERE version=9;
COMMIT;
