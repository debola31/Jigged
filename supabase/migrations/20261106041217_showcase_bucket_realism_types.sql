-- The `showcase` bucket takes three more types, for the shop's realism (approved by the user,
-- 2026-11-05):
--
--   image/vnd.radiance   room/*.hdr                 the room's lighting environment (Poly Haven, CC0)
--   image/ktx2           tiles/*.ktx2               the realistic models' shared surface textures
--   application/json     tiles/tiles.json,          which tiles exist, and which realistic models do
--                        models-full/manifest.json
--
-- Everything else stays as 20261103034602 set it: public reads, service-role writes only, no policies
-- on storage.objects, 50 MB a file. Applied in production by hand the same day, so the room and the
-- models could be published before this merges; this migration records it. Setting the whole list
-- makes it the same wherever it runs, and on a database without the bucket it updates nothing.

UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'model/gltf-binary',
  'video/mp4',
  'image/webp',
  'image/vnd.radiance',
  'image/ktx2',
  'application/json'
]
WHERE id = 'showcase';
