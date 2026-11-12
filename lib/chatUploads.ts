import { z } from 'zod';

/** Bytes go straight to private Storage; only these small references reach chat. */
export const CHAT_MAX_FILES = 150;
export const CHAT_MAX_BYTES = 100 * 1024 * 1024;
export const CHAT_MAX_UPLOADS = 3;
export const CHAT_FILE_ACCEPT = '.zip,.pdf,.dxf,.step,.stp';

export const chatUploadRefSchema = z.object({
  id: z.guid(),
  name: z.string().min(1).max(255),
  manifest_path: z.string().max(500),
  file_count: z.number().int().min(1).max(CHAT_MAX_FILES),
  part_count: z.number().int().min(1).max(50),
  summary: z.string().max(24_000),
});
export type ChatUploadRef = z.infer<typeof chatUploadRefSchema>;

const storedFileSchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(500),
  kind: z.enum(['pdf', 'dxf', 'step']),
  size: z.number().int().positive().max(CHAT_MAX_BYTES),
  mime_type: z.string().max(100),
});
export type ChatStoredFile = z.infer<typeof storedFileSchema>;

export const uploadedPartSchema = z.object({
  stem: z.string().min(1).max(255),
  part_name: z.string().min(1).max(255),
  description: z.string().max(2000),
  customer_part_number: z.string().max(255),
  customer_drawing_number: z.string().max(255),
  customer_revision: z.string().max(100),
  read_source: z.enum(['dxf', 'pdf', 'none']),
  files: z.array(storedFileSchema).min(1).max(CHAT_MAX_FILES),
});

export const chatUploadManifestSchema = z.object({
  version: z.literal(1),
  parts: z.array(uploadedPartSchema).min(1).max(50),
});
export type ChatUploadManifest = z.infer<typeof chatUploadManifestSchema>;

/** An exact namespace, never a URL or a path selected by a model outside this company. */
export function isChatManifestPath(companyId: string, path: string): boolean {
  const segments = path.split('/');
  return segments.length === 5 && segments[0] === companyId && segments[1] === 'chat'
    && z.guid().safeParse(segments[2]).success && z.guid().safeParse(segments[3]).success
    && segments[4] === 'manifest.json';
}
