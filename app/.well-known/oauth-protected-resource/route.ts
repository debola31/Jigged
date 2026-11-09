import { metadataCorsOptionsRequestHandler, protectedResourceHandler } from 'mcp-handler';

import { MCP_PATH, authorizationServerUrl } from '@/lib/mcp/metadata';

/**
 * The bare form of the protected-resource metadata, for clients that look at the root before the
 * path-suffixed URL. `/mcp` is the only protected resource on this host, so it names that one
 * explicitly rather than the origin.
 */
export function GET(req: Request): Response {
  const resourceUrl = new URL(MCP_PATH, req.url).href;
  return protectedResourceHandler({ authServerUrls: [authorizationServerUrl()], resourceUrl })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
