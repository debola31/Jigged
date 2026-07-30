import { brandIconResponse } from '@/lib/brandMark';

/**
 * 512×512 `maskable` PNG.
 *
 * Android crops this to the launcher's own shape, so the mark is smaller and the corners are square:
 * only the inner ~80% is guaranteed to survive, and the launcher supplies the rounding.
 */
export function GET() {
  return brandIconResponse({ size: 512, markRatio: 0.56, rounded: false });
}
