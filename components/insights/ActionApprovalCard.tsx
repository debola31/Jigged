'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import PendingActionsOutlinedIcon from '@mui/icons-material/PendingActionsOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import type { ChatDecisionKind, PendingAction } from '@/utils/insightsAccess';

interface ActionApprovalCardProps {
  actions: PendingAction[];
  /** A decision is on its way; every button waits. */
  busy: boolean;
  onDecide: (decision: ChatDecisionKind) => void;
}

/**
 * A change Jigged chat wants to make, waiting for the person who asked.
 *
 * Nothing in Jigged changes until they choose. The sentence shown is the model's own
 * account of exactly what will change, written for this card; what runs on Approve is
 * the call it describes, loaded server-side from the job -- the browser sends only the
 * decision.
 *
 * "Always allow" is per person and per action (the user's call, 2026-11-09): it covers
 * the actions named here, for the person clicking, in this company, and is turned off
 * under Allowed actions beside Chat history. A destructive action (archive, void,
 * cancel, convert, the QuickBooks push) says so with a warning label, never colour
 * alone.
 */
export default function ActionApprovalCard({ actions, busy, onDecide }: ActionApprovalCardProps) {
  if (actions.length === 0) return null;
  const titles = Array.from(new Set(actions.map((a) => a.title)));
  const named = titles.map((t) => `“${t}”`).join(', ');

  return (
    <Box
      role="group"
      aria-label="Change waiting for your approval"
      sx={{
        mt: 1.5,
        p: 2,
        border: '1px solid',
        borderColor: actions.some((a) => a.destructive) ? 'warning.main' : 'primary.main',
        borderRadius: 1,
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <PendingActionsOutlinedIcon color="primary" aria-hidden />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            {actions.length === 1 ? 'Approve this change?' : `Approve these ${actions.length} changes?`}
          </Typography>
          {actions.map((action) => (
            <Box key={action.id} sx={{ mt: 1 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {action.title}
                </Typography>
                {action.destructive && (
                  <Chip
                    size="small"
                    variant="outlined"
                    color="warning"
                    icon={<WarningAmberOutlinedIcon />}
                    label="Check carefully"
                  />
                )}
              </Stack>
              {action.summary && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                  {action.summary}
                </Typography>
              )}
            </Box>
          ))}
        </Box>
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 2 }}>
        <Button variant="contained" onClick={() => onDecide('approve')} disabled={busy} sx={{ minHeight: 48 }}>
          Approve
        </Button>
        <Button variant="outlined" onClick={() => onDecide('always')} disabled={busy} sx={{ minHeight: 48 }}>
          Always allow
        </Button>
        {/* Declining changes nothing, so it is the quiet option, set apart on the right. */}
        <Button
          variant="text"
          color="inherit"
          onClick={() => onDecide('decline')}
          disabled={busy}
          sx={{ minHeight: 48, ml: { sm: 'auto' } }}
        >
          Decline
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        Always allow skips this step for {named} from now on, for you only. You can turn it off under
        Allowed actions.
      </Typography>
    </Box>
  );
}
