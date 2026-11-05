-- Create the `showcase` storage bucket: what the public showcase page (/showcase) loads.
--
-- The moonshot showcase serves its 3D shop models, step videos and stills from Supabase Storage,
-- never from the Next build (docs/moonshot/shop-and-pipeline-plan.md §1, "Hosting"). They are
-- written by `python -m moonshot.web.media upload` from the hub, with the service role, and read
-- by anyone who opens the page:
--
--   models/<asset>.glb           the shop's decimated GLBs
--   video/<part>/<step>.mp4      a person's step: one video
--   still/<part>/<step>.webp     a machine cycle: one still of the part after the cut
--   cut/<part>/<step>.glb        ... and that part as a model, for a desktop to turn
--
--   public = true           — the page is public and has no session; objects are read through the
--                             public URL, which does not consult RLS on storage.objects
--   file_size_limit = 50 MB — a 1080p step video is a few MB; nothing published is near this
--   allowed_mime_types      — GLB, MP4 and WebP only. Nothing else belongs here, and refusing it
--                             in Postgres holds whatever calls it.
--
-- NO POLICIES on storage.objects, deliberately. Reads need none (public bucket); every write is
-- the service role's, which bypasses RLS. A policy granting anon or authenticated INSERT here
-- would let anyone publish files under jigged's domain.
--
-- Created in production by hand on 2026-11-03 (with the user's approval) so the models could be
-- uploaded before this branch merges; this migration brings it under version control, as
-- 20260728212230 did for `attachments`. ON CONFLICT DO NOTHING so it is a no-op there and never
-- rewrites a live bucket's settings.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('showcase', 'showcase', true, 52428800, ARRAY['model/gltf-binary', 'video/mp4', 'image/webp'])
ON CONFLICT (id) DO NOTHING;
