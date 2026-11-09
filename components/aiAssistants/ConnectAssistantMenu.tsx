'use client';

import { useState } from 'react';
import Button from '@mui/material/Button';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import posthog from 'posthog-js';

import { CHATGPT_URL, claudeInstallLink, mcpServerUrl } from '@/lib/mcp/connectLinks';

/**
 * "Connect your assistant": one button, a menu of three ways in, a line of steps under each.
 *
 * A MENU, NOT A PAGE (the user's call, 2026-11-09). Connecting used to go through
 * /dashboard/{id}/ai-assistants first, a page whose only job was to hold these buttons. Claude's
 * link opens its Add-connector dialog already filled in; ChatGPT has no such link for an app
 * outside its directory, so it copies the server URL and opens ChatGPT; anything else gets the
 * URL. Every route ends on Jigged's consent page (/oauth/consent), where the person clicks Allow.
 *
 * THE STEPS ARE CLAUDE'S, NOT OURS. After Add, Claude asks to Connect (our sign-in), and a chat
 * then needs Jigged switched on under + → Connectors: a per-chat switch Jigged cannot set. The
 * one-line hints say so, because both surprised the owner on first use.
 */
export default function ConnectAssistantMenu({
  opens = 'down',
}: {
  /** `up` where the button sits low on the page (the dashboard strip), so the menu doesn't cover it. */
  opens?: 'up' | 'down';
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [notice, setNotice] = useState<{ severity: 'success' | 'warning'; text: string } | null>(null);

  const serverUrl = mcpServerUrl(typeof window === 'undefined' ? '' : window.location.origin);

  const copyServerUrl = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(serverUrl);
      setNotice({ severity: 'success', text: 'Link copied' });
    } catch {
      setNotice({ severity: 'warning', text: `Couldn't copy the link. It is ${serverUrl}` });
    }
  };

  const close = () => setAnchor(null);

  return (
    <>
      <Button
        variant="outlined"
        endIcon={<ExpandMoreIcon />}
        aria-haspopup="menu"
        aria-expanded={anchor ? 'true' : undefined}
        aria-controls={anchor ? 'connect-assistant-menu' : undefined}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ minHeight: 48, flexShrink: 0 }}
      >
        Connect your assistant
      </Button>
      <Menu
        id="connect-assistant-menu"
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
        anchorOrigin={{ vertical: opens === 'up' ? 'top' : 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: opens === 'up' ? 'bottom' : 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { maxWidth: 380 } } }}
      >
        <MenuItem
          component="a"
          href={claudeInstallLink(serverUrl)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => {
            posthog.capture('ai assistant connect started', { client_kind: 'claude' });
            close();
          }}
          sx={{ minHeight: 48, alignItems: 'flex-start', whiteSpace: 'normal' }}
        >
          <ListItemIcon sx={{ mt: 0.5 }}>
            <OpenInNewIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Add to Claude"
            secondary="Click Add, then Connect and Allow. In a chat, turn Jigged on under + → Connectors."
          />
        </MenuItem>
        <MenuItem
          onClick={() => {
            posthog.capture('ai assistant connect started', { client_kind: 'chatgpt' });
            close();
            void copyServerUrl();
            window.open(CHATGPT_URL, '_blank', 'noopener,noreferrer');
          }}
          sx={{ minHeight: 48, alignItems: 'flex-start', whiteSpace: 'normal' }}
        >
          <ListItemIcon sx={{ mt: 0.5 }}>
            <OpenInNewIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="Open ChatGPT"
            secondary="Copies the link. Paste it when you add an app in ChatGPT's settings (developer mode)."
          />
        </MenuItem>
        <MenuItem
          onClick={() => {
            posthog.capture('ai assistant connect started', { client_kind: 'other' });
            close();
            void copyServerUrl();
          }}
          sx={{ minHeight: 48, alignItems: 'flex-start', whiteSpace: 'normal' }}
        >
          <ListItemIcon sx={{ mt: 0.5 }}>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Copy link" secondary="For any other assistant that supports MCP." />
        </MenuItem>
      </Menu>
      <Snackbar
        open={notice !== null}
        autoHideDuration={notice?.severity === 'warning' ? null : 4000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {notice ? (
          <Alert severity={notice.severity} onClose={() => setNotice(null)} variant="filled">
            {notice.text}
          </Alert>
        ) : undefined}
      </Snackbar>
    </>
  );
}
