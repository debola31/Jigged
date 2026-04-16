-- Migration: Add shop contact/address fields to companies table
-- Powers the "FROM" block on printable quote PDFs. All nullable — shops fill
-- in whatever they want, and the PDF renders only populated lines.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_line2 TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS country TEXT;
