import type { PartAttachmentKind } from '@/types/part';

/** Short display label for a kind chip. */
export const KIND_LABEL: Record<PartAttachmentKind, string> = {
  pdf: 'PDF',
  step: 'STEP',
  dwg: 'DWG',
  dxf: 'DXF',
  other: 'File',
};

/** MUI Chip color per kind — keeps the Files list scannable at a glance. */
export const KIND_CHIP_COLOR: Record<
  PartAttachmentKind,
  'error' | 'info' | 'warning' | 'success' | 'default'
> = {
  pdf: 'error',
  step: 'info',
  dwg: 'warning',
  dxf: 'success',
  other: 'default',
};

/**
 * Whether a kind can be previewed in-app (vs. download-only). PDF renders in an
 * iframe; STEP renders in the lazy-loaded 3D viewer. DWG/other are download-only.
 *
 * DXF is download-only for now. It is the file the extractor READS, so it earns
 * its place as an attachment regardless — rendering it needs a viewer and
 * self-hosted fonts, which is a separate piece of work.
 */
export function isPreviewable(kind: PartAttachmentKind): boolean {
  return kind === 'pdf' || kind === 'step';
}
