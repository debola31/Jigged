import { brandIconResponse } from '@/lib/brandMark';

/** 512×512 PNG for the web app manifest (install prompts and splash screens). */
export function GET() {
  return brandIconResponse({ size: 512 });
}
