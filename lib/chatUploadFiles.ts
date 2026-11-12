import { unzipSync } from 'fflate';
import { CHAT_MAX_BYTES, CHAT_MAX_FILES } from '@/lib/chatUploads';
import { classifyFile } from '@/lib/drawingFileGroups';

const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const supported = (name: string) => classifyFile(name) !== 'other';
const junk = (path: string) => path.split('/').some((p) => p.startsWith('.') || p === '__MACOSX')
  || path.split('/').at(-1)?.toLowerCase() === 'thumbs.db';

/** Bounded before inflation. Folder paths survive so same-named parts never merge. */
export async function expandChatFiles(selected: File[]): Promise<File[]> {
  let count = 0;
  let bytes = 0;
  const output: File[] = [];
  const reserve = (size: number) => {
    count += 1;
    bytes += size;
    if (count > CHAT_MAX_FILES || bytes > CHAT_MAX_BYTES) {
      throw new Error(`Add up to ${CHAT_MAX_FILES} files and 100 MB of expanded files at a time.`);
    }
  };
  for (const file of selected) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      if (file.size > MAX_ZIP_BYTES) throw new Error('That ZIP is larger than 25 MB. Split it into smaller packages.');
      let entries: ReturnType<typeof unzipSync>;
      try {
        entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
          filter: (entry) => {
            const path = entry.name.replace(/\\/g, '/');
            if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('The ZIP contains an unsafe file path.');
            if (path.endsWith('/') || junk(path) || entry.originalSize === 0) return false;
            if (!supported(path)) throw new Error('ZIP packages can contain PDF, DXF and STEP files. Remove other file types first.');
            reserve(entry.originalSize);
            return true;
          },
        });
      } catch (err) {
        if (err instanceof Error && /files|ZIP|path/.test(err.message)) throw err;
        throw new Error('Could not open that ZIP. Check that it is a valid, unencrypted ZIP file.');
      }
      for (const [entryName, data] of Object.entries(entries)) {
        const path = entryName.replace(/\\/g, '/');
        const name = path.slice(path.lastIndexOf('/') + 1);
        const extracted = new File([new Uint8Array(data)], name);
        // Include the archive name: two packages with the same folder layout are separate.
        Object.defineProperty(extracted, 'webkitRelativePath', { value: `${file.name}/${path}` });
        output.push(extracted);
      }
    } else {
      if (!supported(file.name)) throw new Error('Attach a ZIP, PDF, DXF or STEP file.');
      if (!file.size) throw new Error(`${file.name} is empty.`);
      reserve(file.size);
      output.push(file);
    }
  }
  if (!output.length) throw new Error('There are no PDF, DXF or STEP files in that package.');
  return output;
}
