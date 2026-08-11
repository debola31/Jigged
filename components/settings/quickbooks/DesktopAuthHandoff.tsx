'use client';

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

/**
 * Handing the QuickBooks Desktop setup link to the shop.
 *
 * This is the step that has no equivalent in the QuickBooks Online flow. There is
 * no OAuth redirect: the link must be opened in a browser ON THE WINDOWS COMPUTER
 * THAT RUNS QUICKBOOKS, which is usually not the computer the admin is sitting
 * at. So the screen's whole job is to get a URL onto another machine and explain
 * what happens when it lands there.
 */

const PREREQS: string[] = [
  'QuickBooks Desktop is open on that computer, signed in as the Admin user.',
  'The company file is in single-user mode for this first setup.',
  'When Windows asks, allow the QuickBooks Web Connector to install and run.',
  'In QuickBooks, choose "Yes, always allow access, even if QuickBooks is not running".',
  'Leave that computer on and online — Jigged reaches QuickBooks through it.',
];

function useCountdown(expiresAt: string | null): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      if (Number.isNaN(ms)) return setLabel(null);
      if (ms <= 0) return setLabel('expired');
      const mins = Math.round(ms / 60000);
      setLabel(mins >= 60 ? `about ${Math.round(mins / 60)} hour(s)` : `about ${mins} minute(s)`);
    };
    tick();
    // Local arithmetic only — no network, so this is not a poll.
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [expiresAt]);
  return label;
}

export default function DesktopAuthHandoff({
  authFlowUrl,
  expiresAt,
  onCheckNow,
  onNewLink,
  checking,
}: {
  authFlowUrl: string;
  expiresAt: string | null;
  onCheckNow: () => void;
  onNewLink: () => void;
  checking?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const remaining = useCountdown(expiresAt);
  const expired = remaining === 'expired';

  const handleCopy = async () => {
    try {
      // navigator.clipboard is undefined outside a secure context, and local
      // development runs on plain http — so the fallback is not hypothetical.
      await navigator.clipboard.writeText(authFlowUrl);
      setCopied(true);
    } catch {
      const el = document.getElementById('qbd-setup-link') as HTMLInputElement | null;
      if (el) {
        el.select();
        try {
          document.execCommand('copy');
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }
    }
  };

  if (expired) {
    return (
      <Alert
        severity="info"
        action={
          <Button color="inherit" size="small" onClick={onNewLink}>
            Get a new link
          </Button>
        }
      >
        That setup link has expired.
      </Alert>
    );
  }

  return (
    <Box>
      <Alert severity="info" sx={{ mb: 2 }}>
        <strong>Open this link on the computer that runs QuickBooks Desktop.</strong>
        <br />
        That&apos;s usually not the computer you&apos;re on now.
      </Alert>

      <TextField
        id="qbd-setup-link"
        fullWidth
        size="small"
        value={authFlowUrl}
        sx={{ mb: 1 }}
        slotProps={{
          htmlInput: { readOnly: true, 'aria-label': 'QuickBooks Desktop setup link' },
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <IconButton onClick={handleCopy} aria-label="Copy setup link" edge="end">
                  {copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
      {/* Persistent, not a timed toast: the audience is a 50-60 year old shop
          owner mid-task, and a confirmation that vanishes is a confirmation
          nobody saw. */}
      {copied && (
        <Typography variant="caption" color="success.main" display="block" sx={{ mb: 2 }}>
          Copied — now paste it into a browser on the QuickBooks computer.
        </Typography>
      )}

      <Typography variant="subtitle2" fontWeight={600} sx={{ mt: 2 }}>
        What happens on that computer
      </Typography>
      <List dense disablePadding sx={{ mb: 2 }}>
        {PREREQS.map((text) => (
          <ListItem key={text} disableGutters sx={{ alignItems: 'flex-start' }}>
            <ListItemIcon sx={{ minWidth: 32, mt: 0.5 }}>
              <CheckCircleOutlineIcon fontSize="small" color="disabled" />
            </ListItemIcon>
            <ListItemText primary={text} slotProps={{ primary: { variant: 'body2' } }} />
          </ListItem>
        ))}
      </List>

      {remaining && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          This link stops working in {remaining}.
        </Typography>
      )}

      <Button variant="contained" onClick={onCheckNow} disabled={checking}>
        {checking ? 'Checking…' : "I've done it — check now"}
      </Button>
    </Box>
  );
}
