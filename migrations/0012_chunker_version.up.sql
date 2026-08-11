-- Chunker versioning (§7 follow-up).
--
-- posting_chunks and facet_chunks already record which embedding model
-- produced them and compare against the source's current content hash to
-- decide staleness (§7). They had no equivalent for the chunk *splitter*
-- itself: chunkText() changing which text ends up in which chunk was
-- invisible to that comparison, so a chunker fix could ship and every
-- already-embedded facet or posting would sit there unaffected, unchanged
-- text and all, until its content happened to change for some unrelated
-- reason. CHUNKER_VERSION (chunk.ts) existed to be bumped for exactly this
-- case, but nothing ever read it back.
--
-- Existing rows backfill to '1' — the version the splitter was at before
-- this column existed — then the default is dropped. From here every insert
-- states its chunker_version explicitly, the same way model and
-- content_hash already work: an omission fails loudly rather than silently
-- taking on a default that could quietly misrepresent what actually
-- produced the row.

ALTER TABLE discovery.posting_chunks ADD COLUMN chunker_version text NOT NULL DEFAULT '1';
ALTER TABLE discovery.posting_chunks ALTER COLUMN chunker_version DROP DEFAULT;

ALTER TABLE discovery.facet_chunks ADD COLUMN chunker_version text NOT NULL DEFAULT '1';
ALTER TABLE discovery.facet_chunks ALTER COLUMN chunker_version DROP DEFAULT;
