/**
 * "What did you make of my folder?" — answered in one sentence.
 *
 * A shop drops 93 files and wants to know we understood them before it reads
 * anything else. A 31-row table does answer that, eventually, by making someone
 * scan it. A sentence answers it at a glance, and the only part worth their
 * attention is where the package is UNEVEN — a part missing its DXF reads more
 * poorly than the twenty-nine that have everything.
 *
 * So the shape is: the total, then the majority, then the exceptions by name.
 */

import type { DrawingFileKind } from '@/types/drawingImport';

export interface FileSummary {
  /** "31 parts from 93 files." */
  headline: string;
  /** The even majority, or null when the package has no majority worth naming. */
  majority: string | null;
  /** Groups that differ from the majority, most useful first. */
  exceptions: string[];
}

const KIND_LABEL: Record<string, string> = {
  dxf: 'DXF',
  pdf: 'PDF',
  step: 'STEP',
};

/** "DXF, PDF and STEP" — the shop's own words for its files. */
function listKinds(kinds: string[]): string {
  const labels = kinds.map((k) => KIND_LABEL[k] ?? k.toUpperCase());
  if (labels.length === 0) return 'no readable files';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/**
 * Describe a grouped package.
 *
 * `signature` is the sorted set of file kinds a part arrived with, which is what
 * makes two parts the "same" for this purpose — not how many files they have.
 */
export function summariseFiles(
  parts: Array<{ kinds: DrawingFileKind[] }>,
  fileCount: number,
): FileSummary {
  const headline =
    `${parts.length} ${plural(parts.length, 'part')} from ` +
    `${fileCount} ${plural(fileCount, 'file')}.`;

  if (parts.length === 0) return { headline, majority: null, exceptions: [] };

  const bySignature = new Map<string, number>();
  for (const part of parts) {
    // `other` is not a thing a shop asked for; it never earns a mention.
    const kinds = [...new Set(part.kinds)].filter((k) => k in KIND_LABEL).sort();
    const key = kinds.join('+');
    bySignature.set(key, (bySignature.get(key) ?? 0) + 1);
  }

  const ranked = [...bySignature.entries()].sort((a, b) => b[1] - a[1]);
  const [topKey, topCount] = ranked[0];

  // "Each" only when it is true of every one of them. Claiming it of 29 out of 31
  // is the kind of small lie that makes someone stop believing the other numbers.
  const majority =
    topCount === parts.length
      ? `Each has ${listKinds(topKey ? topKey.split('+') : [])}.`
      : `${topCount} ${topCount === 1 ? 'has' : 'have'} ${listKinds(topKey ? topKey.split('+') : [])}.`;

  const exceptions = ranked.slice(1).map(([key, count]) => {
    const kinds = key ? key.split('+') : [];
    return `${count} ${count === 1 ? 'has' : 'have'} ${listKinds(kinds)}`;
  });

  return { headline, majority, exceptions };
}
