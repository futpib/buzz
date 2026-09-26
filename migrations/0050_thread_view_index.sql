-- Direct-reply thread windows use a composite keyset over one tenant, root,
-- channel, and displayed thread head. The prior root-only index still left
-- PostgreSQL to sort every reply in a long thread before returning the first
-- bounded page.
--
-- Brownfield note: SQLx wraps this migration in a transaction, so PostgreSQL
-- cannot build the index CONCURRENTLY here. A normal build takes a SHARE lock
-- and blocks thread_metadata writes while it runs. On a large live database,
-- prebuild this exact index with CREATE INDEX CONCURRENTLY before deploying.
-- Skip CREATE entirely for a prebuilt index, matching migration 0049: even
-- CREATE IF NOT EXISTS would otherwise acquire a writer-conflicting lock.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $$
BEGIN
    IF to_regclass('public.idx_thread_metadata_root_window') IS NULL THEN
        CREATE INDEX idx_thread_metadata_root_window
            ON public.thread_metadata (
                community_id, root_event_id, channel_id, parent_event_id,
                event_created_at DESC, event_id ASC
            )
            WHERE root_event_id IS NOT NULL AND parent_event_id IS NOT NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'idx_thread_metadata_root_window'
          AND i.indisvalid AND i.indisready AND i.indislive
          AND pg_get_indexdef(i.indexrelid) =
              'CREATE INDEX idx_thread_metadata_root_window ON public.thread_metadata USING btree (community_id, root_event_id, channel_id, parent_event_id, event_created_at DESC, event_id) WHERE ((root_event_id IS NOT NULL) AND (parent_event_id IS NOT NULL))'
    ) THEN
        RAISE EXCEPTION 'idx_thread_metadata_root_window invalid or wrong definition';
    END IF;
END $$;
