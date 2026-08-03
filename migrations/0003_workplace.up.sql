-- M2 taught the domain model something: Lever and Ashby both publish a
-- workplace-modality field (`workplaceType`) as a source assertion. The model
-- previously only had the derived remote_hint guess. An assertion is not a
-- guess, so it gets a source-asserted column in `postings` rather than being
-- laundered through `posting_derived`.
--
-- Verbatim from the feed: Lever says 'remote' | 'hybrid' | 'onsite', Ashby says
-- 'Remote' | 'Hybrid' | 'OnSite'. No CHECK constraint — this column records
-- what the source said, and the source's vocabulary is not ours to constrain.

ALTER TABLE discovery.postings ADD COLUMN workplace_raw text;

COMMENT ON COLUMN discovery.postings.workplace_raw IS 'The feed''s own workplace-modality label, verbatim. Null when the source publishes none (Greenhouse).';
