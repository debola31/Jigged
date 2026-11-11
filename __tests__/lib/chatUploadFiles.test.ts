import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { expandChatFiles } from '@/lib/chatUploadFiles';
import { groupDrawingFiles } from '@/lib/drawingFileGroups';
import { CHAT_MAX_FILES } from '@/lib/chatUploads';

function zip(entries: Record<string, Uint8Array>) {
  return new File([new Uint8Array(zipSync(entries))], 'parts.zip');
}

describe('chat drawing packages', () => {
  it('groups the drawing and differently numbered STEP model as one part', async () => {
    const files = await expandChatFiles([zip({
      'pkg/1011770-drawing.pdf': strToU8('PDF'),
      'pkg/1011770-drawing.dxf': strToU8('DXF'),
      'pkg/1011770-model.step': strToU8('STEP'),
      '__MACOSX/._drawing.pdf': strToU8('junk'),
      'pkg/.DS_Store': strToU8('junk'),
    })]);
    const groups = groupDrawingFiles(files);
    expect(groups).toHaveLength(1);
    expect(groups[0].files).toHaveLength(3);
  });

  it('keeps same-named drawings in separate folders separate', async () => {
    const files = await expandChatFiles([zip({
      'part-a/drawing.pdf': strToU8('A'), 'part-b/drawing.pdf': strToU8('B'),
    })]);
    expect(groupDrawingFiles(files)).toHaveLength(2);
  });

  it('rejects traversal, nested archives, invalid ZIPs and unsupported files', async () => {
    await expect(expandChatFiles([zip({ '../secret.pdf': strToU8('bad') })])).rejects.toThrow(/unsafe/);
    await expect(expandChatFiles([zip({ 'nested.zip': strToU8('bad') })])).rejects.toThrow(/file types/);
    await expect(expandChatFiles([new File(['broken'], 'bad.zip')])).rejects.toThrow(/valid, unencrypted/);
    await expect(expandChatFiles([new File(['data'], 'script.exe')])).rejects.toThrow(/ZIP, PDF/);
  });

  it('bounds the file count before expanding an archive', async () => {
    const entries = Object.fromEntries(Array.from({ length: CHAT_MAX_FILES + 1 }, (_, i) => [`part-${i}.dxf`, strToU8('x')]));
    await expect(expandChatFiles([zip(entries)])).rejects.toThrow(/150 files/);
  });

  it('rejects a zip bomb based on its declared expanded size before inflating it', async () => {
    const packed = zipSync({ 'big.dxf': strToU8('small') });
    // The central directory contains the original size at offset 24.
    const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
    for (let i = 0; i < packed.length - 28; i++) {
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 101 * 1024 * 1024, true);
    }
    await expect(expandChatFiles([new File([new Uint8Array(packed)], 'bomb.zip')])).rejects.toThrow(/100 MB/);
  });
});
