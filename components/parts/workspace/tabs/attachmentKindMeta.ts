import type { PartAttachmentKind } from '@/types/part';

/** Short display label for a kind chip. */
export const KIND_LABEL: Record<PartAttachmentKind, string> = {
  pdf: 'PDF',
  step: 'STEP',
  dwg: 'DWG',
  other: 'File',
};

/** MUI Chip color per kind — keeps the Files list scannable at a glance. */
export const KIND_CHIP_COLOR: Record<
  PartAttachmentKind,
  'error' | 'info' | 'warning' | 'default'
> = {
  pdf: 'error',
  step: 'info',
  dwg: 'warning',
  other: 'default',
};

/**
 * Whether a kind can be previewed in-app (vs. download-only). PDF previews now;
 * STEP gains an in-app 3D viewer in Phase 2 (flip it to true then).
 */
export function isPreviewable(kind: PartAttachmentKind): boolean {
  return kind === 'pdf';
}
