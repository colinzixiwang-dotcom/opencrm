-- Stop order-index workers and the feature server before execution.
-- Optional: export the two tables first; this deletes the rebuildable projection.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM integration.order_index_jobs WHERE status IN ('running','pending')) THEN
  RAISE EXCEPTION 'Active backfill exists: stop and reconcile its status before rollback';
 END IF;
END $$;
DELETE FROM access_control.sys_role_menu WHERE menu_id IN
 (SELECT menu_id FROM access_control.sys_menu WHERE perms IN
 ('erp:orders:view','erp:orders:list','erp:orders:search','erp:orders:detail'));
DELETE FROM access_control.sys_menu WHERE perms IN
 ('erp:orders:view','erp:orders:list','erp:orders:search','erp:orders:detail');
DROP TABLE order_reference.order_index_records;
DROP TABLE integration.order_index_jobs;
DELETE FROM integration.schema_migrations WHERE version=10;
COMMIT;
