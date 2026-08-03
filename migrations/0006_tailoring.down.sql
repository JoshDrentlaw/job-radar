DROP TABLE dossier.document_citations;
DROP TABLE dossier.document_paragraphs;
DROP TABLE dossier.documents;
DROP TABLE dossier.rewrite_proposals;
DROP TABLE dossier.tailoring_runs;

-- Narrative facts would violate the restored constraint; they are not
-- resume-shaped, so there is no honest automatic conversion. Fail loudly.
ALTER TABLE dossier.facts DROP CONSTRAINT facts_kind_check;
ALTER TABLE dossier.facts ADD CONSTRAINT facts_kind_check CHECK (kind IN
  ('summary', 'role', 'bullet', 'skill', 'education', 'project'));
