'use client';

import { useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import posthog from 'posthog-js';

import { CHATGPT_URL, claudeInstallLink, mcpServerUrl } from '@/lib/mcp/connectLinks';

type Kind = 'claude' | 'chatgpt';

/**
 * "Connect your assistant": one button, and a dialog with a card for Claude and a card for
 * ChatGPT. Each card has three numbered steps, the server URL and its buttons.
 *
 * A DIALOG, NOT A PAGE. Connecting must not send anyone to another page first (the user's call,
 * 2026-11-09). A one-line menu (#906) was too thin for ChatGPT, whose setup is the longer of the
 * two, so each assistant now gets its steps written out, as on tech-week.com/mcp.
 *
 * THE STEPS ARE THE ASSISTANTS' OWN SCREENS, so they date. Claude's link opens its Add dialog
 * filled in (claude.com/docs/connectors/custom/add-unlisted); the per-chat switch is Claude's,
 * not ours. ChatGPT adds a custom MCP server from its Plugins page
 * (developers.openai.com/api/docs/guides/custom-mcp-server). Recheck both when either changes.
 * Every route ends on Jigged's consent page (/oauth/consent), where the person clicks Allow.
 */
export default function ConnectAssistantButton() {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<{ severity: 'success' | 'warning'; text: string } | null>(null);

  const serverUrl = mcpServerUrl(typeof window === 'undefined' ? '' : window.location.origin);

  const copyServerUrl = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(serverUrl);
      setNotice({ severity: 'success', text: 'URL copied' });
    } catch {
      setNotice({ severity: 'warning', text: `Couldn't copy. The URL is ${serverUrl}` });
    }
  };

  const started = (kind: Kind) => posthog.capture('ai assistant connect started', { client_kind: kind });

  return (
    <>
      <Button variant="outlined" onClick={() => setOpen(true)} sx={{ minHeight: 48, flexShrink: 0 }}>
        Connect your assistant
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md" aria-labelledby="connect-assistant-title">
        <DialogTitle id="connect-assistant-title" sx={{ pr: 7 }}>
          Connect your assistant
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            It takes about a minute, and you only do it once.
          </Typography>
          <IconButton
            aria-label="Close"
            onClick={() => setOpen(false)}
            sx={{ position: 'absolute', right: 12, top: 12 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
              gap: 2,
            }}
          >
            <AssistantCard
              title="Claude"
              subtitle="Works on claude.ai and in the Claude apps."
              steps={[
                <>
                  Click <strong>Add to Claude</strong>. Claude opens with Jigged filled in; click <strong>Add</strong>.
                </>,
                <>
                  Click <strong>Connect</strong>, sign in to Jigged and click <strong>Allow</strong>.
                </>,
                <>
                  In a new chat, turn Jigged on under <strong>+ → Connectors</strong>.
                </>,
              ]}
              serverUrl={serverUrl}
              onCopy={() => {
                started('claude');
                void copyServerUrl();
              }}
              action={
                <Button
                  variant="contained"
                  href={claudeInstallLink(serverUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  endIcon={<OpenInNewIcon />}
                  onClick={() => started('claude')}
                  sx={{ minHeight: 48 }}
                >
                  Add to Claude
                </Button>
              }
            />
            <AssistantCard
              title="ChatGPT"
              subtitle="Set it up once on chatgpt.com, in a web browser."
              steps={[
                <>
                  Click <strong>Open ChatGPT</strong>. It copies the URL and opens Plugins; click{' '}
                  <strong>+</strong>, then <strong>Add custom MCP server</strong>.
                </>,
                <>
                  Name it Jigged, paste the URL, choose <strong>OAuth</strong>, accept the warning and click{' '}
                  <strong>Create as a plugin</strong>.
                </>,
                <>
                  Install it, sign in to Jigged and click <strong>Allow</strong>. In a chat, type{' '}
                  <strong>@</strong> and pick Jigged.
                </>,
              ]}
              serverUrl={serverUrl}
              onCopy={() => {
                started('chatgpt');
                void copyServerUrl();
              }}
              action={
                <Button
                  variant="contained"
                  endIcon={<OpenInNewIcon />}
                  onClick={() => {
                    started('chatgpt');
                    void copyServerUrl();
                    window.open(CHATGPT_URL, '_blank', 'noopener,noreferrer');
                  }}
                  sx={{ minHeight: 48 }}
                >
                  Open ChatGPT
                </Button>
              }
            />
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            Another assistant that supports MCP uses the same URL. Operators can&apos;t connect one.
          </Typography>
        </DialogContent>
      </Dialog>

      <Snackbar
        open={notice !== null}
        autoHideDuration={notice?.severity === 'warning' ? null : 3000}
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

function AssistantCard({
  title,
  subtitle,
  steps,
  serverUrl,
  onCopy,
  action,
}: {
  title: string;
  subtitle: string;
  steps: ReactNode[];
  serverUrl: string;
  onCopy: () => void;
  action: ReactNode;
}) {
  return (
    <Box
      component="section"
      aria-label={title}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        p: 2.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
      }}
    >
      <Box>
        <Typography variant="h6" component="h3" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {subtitle}
        </Typography>
      </Box>
      <Box component="ol" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {steps.map((step, i) => (
          <Typography key={i} component="li" variant="body2">
            {step}
          </Typography>
        ))}
      </Box>
      <Box sx={{ mt: 'auto', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography
          component="code"
          sx={{
            display: 'block',
            fontFamily: 'monospace',
            fontSize: '0.875rem',
            p: 1.5,
            borderRadius: 1,
            bgcolor: 'action.hover',
            wordBreak: 'break-all',
          }}
        >
          {serverUrl}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button variant="outlined" onClick={onCopy} sx={{ minHeight: 48 }}>
            Copy URL
          </Button>
          {action}
        </Box>
      </Box>
    </Box>
  );
}
