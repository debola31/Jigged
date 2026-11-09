import { metadataCorsOptionsRequestHandler, protectedResourceHandler } from 'mcp-handler';

import { authorizationServerUrl } from '@/lib/mcp/metadata';

/**
 * Protected-resource metadata for `/mcp` (RFC 9728, path-suffixed form). This is the URL every
 * 401 from `/mcp` points at. `resource` is derived from this request's own URL with the
 * `/.well-known/oauth-protected-resource` prefix stripped, so it reads `<origin>/mcp` on every
 * deployment, previews included.
 */
export function GET(req: Request): Response {
  return protectedResourceHandler({ authServerUrls: [authorizationServerUrl()] })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
