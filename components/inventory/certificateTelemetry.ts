/**
 * Shared shape for the `lot certificate uploaded` event's file properties.
 *
 * Here rather than inline at each call site so the four surfaces cannot drift into describing the
 * same file three different ways — and so the rule below is stated once.
 *
 * **Nothing here describes the cert's CONTENT.** Not the file name, not the heat, not the supplier.
 * A mill cert is the customer's business data; what we measure is the shape of the interaction:
 * whether the shop's existing scan-to-PDF workflow feeds this, or whether people photograph paper.
 */
export function certificateUploadProperties(file: File): {
  file_kind: 'pdf' | 'image' | 'other';
  size_bucket: 'under_1mb' | '1_5mb' | '5_25mb';
} {
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  const file_kind =
    ext === 'pdf' ? 'pdf' : ['jpg', 'jpeg', 'png', 'heic', 'heif', 'tif', 'tiff'].includes(ext)
      ? 'image'
      : 'other';

  const mb = file.size / (1024 * 1024);
  // Bucketed against the budget in `uploadTimeoutMs` (20s + bytes/60), so a shift here shows up as
  // a shift in how often uploads time out rather than as an unexplained size distribution.
  const size_bucket = mb < 1 ? 'under_1mb' : mb < 5 ? '1_5mb' : '5_25mb';

  return { file_kind, size_bucket };
}
