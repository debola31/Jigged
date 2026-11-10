/**
 * The links that start connecting an AI assistant to Jigged. Pure, so the page and its tests agree.
 *
 * Claude documents an install link that opens its "Add custom connector" dialog with the name and
 * URL filled in; the person still confirms there, and then signs in and clicks Allow on Jigged's
 * consent page. ChatGPT has no such link for an app outside its directory, so the best the page
 * can do is copy the server URL and open ChatGPT's Plugins page, where it is pasted. Once the directory listings are approved, both
 * buttons point at the listing pages instead.
 * https://claude.com/docs/connectors/building/directory-vs-custom
 */

export const CONNECTOR_NAME = 'Jigged';

/** The MCP server's URL, as an assistant needs it: `<origin>/mcp`. */
export function mcpServerUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/mcp`;
}

export function claudeInstallLink(serverUrl: string): string {
  const params = new URLSearchParams({
    modal: 'add-custom-connector',
    connectorName: CONNECTOR_NAME,
    connectorUrl: serverUrl,
  });
  return `https://claude.ai/customize/connectors?${params.toString()}`;
}

/** ChatGPT's Plugins page, where a custom MCP server is added (+ → Add custom MCP server). */
export const CHATGPT_URL = 'https://chatgpt.com/plugins';
