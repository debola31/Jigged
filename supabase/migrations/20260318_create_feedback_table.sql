-- In-app feedback mechanism (issue #72)
-- Stores user feedback submitted from within the app.
-- Primary delivery is email via notify-feedback Edge Function;
-- this table serves as an archive.

CREATE TABLE feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_path TEXT NOT NULL,
  page_title TEXT NOT NULL,
  feedback_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE feedback IS 'In-app user feedback submissions';
COMMENT ON COLUMN feedback.page_path IS 'The URL pathname where feedback was submitted';
COMMENT ON COLUMN feedback.page_title IS 'Human-readable page name at time of submission';

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Users can submit feedback for companies they belong to
CREATE POLICY "Users can insert feedback for their companies"
  ON feedback FOR INSERT
  WITH CHECK (
    company_id IN (
      SELECT uca.company_id FROM user_company_access uca
      WHERE uca.user_id = auth.uid()
    )
  );

-- Admins can read feedback for their companies
CREATE POLICY "Admins can read feedback for their companies"
  ON feedback FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_company_access uca
      WHERE uca.user_id = auth.uid()
        AND uca.company_id = feedback.company_id
        AND uca.role = 'admin'
    )
  );
