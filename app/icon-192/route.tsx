import { brandIconResponse } from '@/lib/brandMark';

/** 192×192 PNG for the web app manifest. Generated, not stored — see `lib/brandMark.tsx`. */
export function GET() {
  return brandIconResponse({ size: 192 });
}
