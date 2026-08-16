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
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import CheckIcon from '@mui/icons-material/Check';
import ComputerIcon from '@mui/icons-material/Computer';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

import { copyText } from '@/utils/clipboard';

/**
 * Handing the QuickBooks Desktop setup over to whoever is at the shop computer.
 *
 * The step with no QuickBooks Online equivalent. There is no OAuth redirect: the
 * setup has to happen in a browser ON THE WINDOWS COMPUTER THAT RUNS QUICKBOOKS,
 * which may or may not be the one the admin is sitting at.
 *
 * So the screen ASKS FIRST rather than assuming. Someone already at the shop PC
 * -- the common case for a small shop, where the office machine IS the QuickBooks
 * machine -- should never have to copy a URL to themselves; we just open it. Only
 * the genuinely remote case gets the copy-and-send treatment.
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

function Checklist({ heading }: { heading: string }) {
  return (
    <>
      <Typography variant="subtitle2" fontWeight={600} sx={{ mt: 2 }}>
        {heading}
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
    </>
  );
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
  /** null = not asked yet. 'here' = at the QuickBooks PC. 'other' = send it on. */
  const [where, setWhere] = useState<null | 'here' | 'other'>(null);
  const [copied, setCopied] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const remaining = useCountdown(expiresAt);
  const expired = remaining === 'expired';

  const openSetupPage = () => {
    setWhere('here');
    // Opened inside the click so the popup blocker allows it. If it is blocked
    // anyway we fall back to showing the link rather than leaving a dead end.
    //
    // Deliberately WITHOUT the 'noopener' feature: with it, window.open returns
    // null by specification even on success, so the blocked-detection below would
    // fire every time and tell the user a tab was blocked while it sat open in
    // front of them. The opener is nulled straight after instead, which is the
    // same reverse-tabnabbing guard the push dialog uses.
    const win = window.open(authFlowUrl, '_blank');
    if (win) win.opener = null;
    setPopupBlocked(!win);
  };

  // The secure-context fallback lives in copyText, shared with the invoice menu
  // so the two cannot drift into handling http://localhost differently.
  const handleCopy = async () => setCopied(await copyText(authFlowUrl));

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

  // ── Step 1: which computer is this? ──
  if (where === null) {
    return (
      <Box>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Setup has to run on the computer where QuickBooks Desktop is installed.
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Button variant="contained" startIcon={<ComputerIcon />} onClick={openSetupPage}>
            I&apos;m on that computer
          </Button>
          <Button variant="outlined" onClick={() => setWhere('other')}>
            It&apos;s a different computer
          </Button>
        </Stack>
      </Box>
    );
  }

  // ── Step 2a: they are here — the page is already open ──
  if (where === 'here') {
    return (
      <Box>
        {popupBlocked ? (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Your browser blocked the new tab.{' '}
            <a href={authFlowUrl} target="_blank" rel="noopener noreferrer">
              Open the setup page
            </a>
            .
          </Alert>
        ) : (
          <Alert
            severity="info"
            sx={{ mb: 2 }}
            action={
              <Button
                color="inherit"
                size="small"
                startIcon={<OpenInNewIcon />}
                onClick={openSetupPage}
              >
                Reopen
              </Button>
            }
          >
            The QuickBooks setup page opened in a new tab. Follow it through, then come back here.
          </Alert>
        )}

        <Checklist heading="What it will ask for" />

        {remaining && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This setup link stops working in {remaining}.
          </Typography>
        )}

        <Stack direction="row" spacing={2}>
          <Button variant="contained" onClick={onCheckNow} disabled={checking}>
            {checking ? 'Checking…' : "I've finished — check now"}
          </Button>
          <Button variant="text" onClick={() => setWhere('other')}>
            Send it to another computer instead
          </Button>
        </Stack>
      </Box>
    );
  }

  // ── Step 2b: it is another machine — hand the link over ──
  return (
    <Box>
      <Alert severity="info" sx={{ mb: 2 }}>
        <strong>Open this link on the computer that runs QuickBooks Desktop.</strong>
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
          owner mid-task, and a confirmation that vanishes is one nobody saw. */}
      {copied && (
        <Typography variant="caption" color="success.main" display="block" sx={{ mb: 2 }}>
          Copied — now paste it into a browser on the QuickBooks computer.
        </Typography>
      )}

      <Checklist heading="What happens on that computer" />

      {remaining && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          This link stops working in {remaining}.
        </Typography>
      )}

      <Stack direction="row" spacing={2}>
        <Button variant="contained" onClick={onCheckNow} disabled={checking}>
          {checking ? 'Checking…' : "They've finished — check now"}
        </Button>
        <Button variant="text" onClick={openSetupPage}>
          Actually, I&apos;m on that computer
        </Button>
      </Stack>
    </Box>
  );
}
