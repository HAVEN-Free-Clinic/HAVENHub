-- rolling-deploy: SpanishAssessmentRecord is a brand-new table introduced in
-- this same branch. No existing code path uses this index in an ON CONFLICT
-- clause, so dropping it carries no risk during the deploy window.
-- DropIndex
DROP INDEX "SpanishAssessmentRecord_email_term_key";