DROP TABLE discovery.matches;
DROP TABLE discovery.facet_chunks;
DROP TABLE discovery.posting_chunks;
DROP TABLE discovery.profile_facets;
-- The extension is left installed: other databases on the shared instance may
-- use it, and dropping it is an operator decision, not a migration's.
