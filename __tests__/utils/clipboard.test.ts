import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from '@/utils/clipboard';

/**
 * The fallback is the point of this module. Development runs on plain
 * http://localhost, where `navigator.clipboard` is undefined -- so a regression
 * that drops the execCommand path would work on every deployed environment and
 * fail on every developer's machine, which is the hardest kind to notice.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the async clipboard API when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copyText('1100')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('1100');
  });

  it('falls back to execCommand outside a secure context', async () => {
    // No navigator.clipboard at all — the http://localhost shape.
    vi.stubGlobal('navigator', {});
    const exec = vi.fn().mockReturnValue(true);
    // jsdom does not implement execCommand, so it is absent rather than failing.
    (document as unknown as { execCommand: unknown }).execCommand = exec;

    await expect(copyText('1100')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('removes the scratch textarea it created', async () => {
    vi.stubGlobal('navigator', {});
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn().mockReturnValue(true);

    await copyText('1100');

    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('reports failure rather than throwing when both paths fail', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn().mockReturnValue(false);

    // A caller must be able to decline to claim success — never a thrown error,
    // because a failed copy is a UI state and not an error path.
    await expect(copyText('1100')).resolves.toBe(false);
  });
});
