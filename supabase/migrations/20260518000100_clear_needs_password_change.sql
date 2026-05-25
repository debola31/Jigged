-- The needs_password_change user_metadata flag is no longer read or written
-- by any code path (admin-triggered password resets now use email-link
-- recovery instead of admin-typed temporary passwords). Drop the dead key
-- from existing auth.users rows so the metadata stays clean.

UPDATE auth.users
SET raw_user_meta_data = raw_user_meta_data - 'needs_password_change'
WHERE raw_user_meta_data ? 'needs_password_change';
