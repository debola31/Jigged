import {
  CHAT_MAX_BYTES, CHAT_MAX_FILES, chatUploadManifestSchema, isChatManifestPath,
  type ChatStoredFile, type ChatUploadManifest, type ChatUploadRef,
} from '@/lib/chatUploads';
import type { BuiltRow } from '@/lib/drawingImportExtract';
import { valueOf } from '@/types/drawingImport';
import {
  deleteFileFromStorage, downloadFileFromStorage, sanitizeFilename, uploadFileToStorage,
} from '@/utils/storageHelpers';

export interface PreparedChatUpload {
  id: string;
  name: string;
  rows: BuiltRow[];
}

/** Explicit file selection only. Parsing is local and makes no AI call. */
export async function prepareChatUpload(files: File[], progress?: (message: string) => void): Promise<PreparedChatUpload> {
  const [{ expandChatFiles }, { groupDrawingFiles }, { buildRows }] = await Promise.all([
    import('@/lib/chatUploadFiles'), import('@/lib/drawingFileGroups'), import('@/lib/drawingImportExtract'),
  ]);
  progress?.('Opening the files…');
  const expanded = await expandChatFiles(files);
  const groups = groupDrawingFiles(expanded);
  if (groups.length > 50) throw new Error('Add up to 50 parts at a time. Split this package into smaller groups.');
  const rows = await buildRows(groups, (done, total) => progress?.(`Reading drawings ${done} of ${total}…`));
  return { id: crypto.randomUUID(), name: files.length === 1 ? files[0].name : `${files.length} drawing files`, rows };
}

/** Direct to private Storage, avoiding the API's 4.5 MB request limit. */
export async function uploadChatFiles(
  companyId: string, threadId: string, prepared: PreparedChatUpload, progress?: (message: string) => void,
): Promise<ChatUploadRef> {
  const folder = `${companyId}/chat/${threadId}/${prepared.id}`;
  const tasks: { file: File; stored: ChatStoredFile }[] = [];
  const manifest: ChatUploadManifest = {
    version: 1,
    parts: prepared.rows.map((row) => ({
      stem: row.stem,
      part_name: valueOf(row, 'part_name'),
      description: valueOf(row, 'description'),
      customer_part_number: valueOf(row, 'customer_part_number'),
      customer_drawing_number: valueOf(row, 'customer_drawing_number'),
      customer_revision: valueOf(row, 'customer_revision'),
      read_source: row.readSource,
      files: row.group.files.map(({ file, kind }) => {
        if (kind === 'other') throw new Error('Only PDF, DXF and STEP files can be uploaded here.');
        const stored: ChatStoredFile = {
          name: file.name, kind, size: file.size, mime_type: file.type,
          path: `${folder}/${crypto.randomUUID()}_${sanitizeFilename(file.name)}`,
        };
        tasks.push({ file, stored });
        return stored;
      }),
    })),
  };
  if (!chatUploadManifestSchema.safeParse(manifest).success) {
    throw new Error('Some drawing names or extracted fields are too long. Send a smaller package or shorten the file names.');
  }
  const summary = JSON.stringify(manifest.parts.map(({ files, ...part }) => ({ ...part, file_count: files.length })));
  if (summary.length > 24_000) throw new Error('That package has too much drawing text for one message. Send fewer parts at a time.');
  const paths: string[] = [];
  let cursor = 0;
  let completed = 0;
  let failure: unknown;
  try {
    await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
      while (!failure && cursor < tasks.length) {
        const { file, stored } = tasks[cursor++];
        paths.push(stored.path);
        try {
          await uploadFileToStorage(stored.path, file);
          progress?.(`Uploading files ${++completed} of ${tasks.length}…`);
        } catch (err) { failure = err; }
      }
    }));
    if (failure) throw failure;
    const manifestPath = `${folder}/manifest.json`;
    paths.push(manifestPath);
    await uploadFileToStorage(manifestPath, new Blob([JSON.stringify(manifest)], { type: 'application/json' }));
    return {
      id: prepared.id, name: prepared.name, manifest_path: manifestPath,
      file_count: tasks.length, part_count: manifest.parts.length, summary,
    };
  } catch (err) {
    // Every in-flight upload settled before cleanup, so a late success cannot resurrect one.
    await Promise.allSettled(paths.map((path) => deleteFileFromStorage(path)));
    throw err;
  }
}

/** Used by both MCP and Jigged chat under the caller's own Storage RLS. */
export async function readChatUpload(companyId: string, manifestPath: string): Promise<ChatUploadManifest> {
  if (!isChatManifestPath(companyId, manifestPath)) throw new Error('That upload does not belong to this company.');
  const blob = await downloadFileFromStorage(manifestPath);
  if (blob.size > 250_000) throw new Error('That upload manifest is too large.');
  const manifest = chatUploadManifestSchema.parse(JSON.parse(await blob.text()));
  const prefix = manifestPath.slice(0, -'manifest.json'.length);
  const files = manifest.parts.flatMap((part) => part.files);
  if (files.length > CHAT_MAX_FILES || files.reduce((n, file) => n + file.size, 0) > CHAT_MAX_BYTES) {
    throw new Error('That upload exceeds the file limit.');
  }
  if (new Set(manifest.parts.map((part) => part.stem)).size !== manifest.parts.length
      || new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error('That upload contains duplicate parts or files.');
  }
  for (const file of files) {
    const leaf = file.path.slice(prefix.length);
    if (!file.path.startsWith(prefix) || !/^[a-f0-9-]{36}_[a-zA-Z0-9._-]+$/.test(leaf)) {
      throw new Error('An uploaded file is outside this package.');
    }
  }
  return manifest;
}
