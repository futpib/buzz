-- Newest-first thread windows use a composite keyset over one tenant, root,
-- channel, and displayed thread head. The prior root-only index still left
-- PostgreSQL to sort every reply in a long thread before returning the first
-- bounded page.
--
-- Brownfield note: SQLx wraps this migration in a transaction, so PostgreSQL
-- cannot build the index CONCURRENTLY here. A normal build takes a SHARE lock
-- and blocks thread_metadata writes while it runs. On a large live database,
-- prebuild this exact index with CREATE INDEX CONCURRENTLY before deploying;
-- IF NOT EXISTS then makes the migration step a no-op.
CREATE INDEX IF NOT EXISTS idx_thread_metadata_root_window
    ON thread_metadata (
        community_id,
        root_event_id,
        channel_id,
        parent_event_id,
        event_created_at DESC,
        event_id ASC
    )
    WHERE root_event_id IS NOT NULL AND parent_event_id IS NOT NULL;
