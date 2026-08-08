'use client';

/**
 * Lets an operator who works for more than one shop move between them.
 *
 * ## Why this exists
 *
 * The office sidebar has had `CompanySwitcher` all along. The operator surface has no sidebar, so
 * an operator with two companies had no way to reach the second one at all — they could only get
 * there by logging out and back in, and even that lands on `last_company_id`. Multi-company
 * operators were previously rare enough for nobody to hit it; the moment invite-acceptance stopped
 * dead-ending for existing users, a person holding two memberships became an ordinary case.
 *
 * ## Placement, which is a constraint rather than a preference
 *
 * This renders as a SIBLING of the identity row in the "Me" tab, never inside it. That row's
 * invariant is that Log out is the only thing in it you can tap — nothing adjacent means nothing
 * for a habituated thumb to slip from. See the header comment of `OperatorAccountBlock.tsx` for the
 * full argument and `MyWorkPage.test.tsx` → "leaves Log out with no neighbouring tap target to slip
 * from" for the assertion that fails if you move it. The obvious tidy-up — making the company name
 * already shown in that row tappable — is exactly what must not happen.
 *
 * ## Renders nothing for a single-company operator
 *
 * Which is nearly all of them. They get no extra control, no extra query beyond the one
 * `useCompanies` already runs, and no change to a screen they use every shift.
 *
 * The persisted station needs no clearing on switch: `lib/operatorStationStorage` keys stations per
 * company, so the new company reads its own remembered machine and never inherits one.
 *
 * Nothing here counts, ranks or averages anything the operator has done — see
 * docs/modules/operator-view.md.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import CheckIcon from '@mui/icons-material/Check';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';

import { useCompanies } from '@/hooks/useCompanies';
import { setLastCompany, homePathForRole } from '@/utils/companyAccess';

export default function OperatorCompanySwitcher({
  companyId,
  userId,
}: {
  companyId: string;
  userId?: string;
}) {
  const router = useRouter();
  const { companies } = useCompanies();
  const [open, setOpen] = useState(false);

  // One company (or still loading) — this control has nothing to offer.
  if (companies.length <= 1) return null;

  const handleSelect = async (targetId: string, role: string | null | undefined) => {
    setOpen(false);
    if (targetId === companyId) return;

    // Remember it before navigating, so the next login lands here rather than bouncing back to
    // the company they just left. A failure to record the preference must not block the switch.
    if (userId) {
      try {
        await setLastCompany(userId, targetId);
      } catch (err) {
        console.error('Could not record last company on switch:', err);
      }
    }

    router.push(homePathForRole(role, targetId));
  };

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        startIcon={<SwapHorizIcon fontSize="small" />}
        size="small"
        sx={{
          minHeight: 40,
          px: 0.5,
          textTransform: 'none',
          color: 'text.secondary',
          '&:hover': { bgcolor: 'transparent', color: 'primary.light' },
        }}
      >
        Switch company
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Switch company</DialogTitle>
        <DialogContent sx={{ px: 1, pb: 2 }}>
          <List disablePadding>
            {companies.map((company) => {
              const isCurrent = company.company_id === companyId;
              return (
                <ListItem key={company.company_id} disablePadding>
                  <ListItemButton
                    onClick={() => handleSelect(company.company_id, company.role)}
                    selected={isCurrent}
                    // Comfortably past the 48px touch floor — this is a phone in a shop.
                    sx={{ minHeight: 56, borderRadius: 1 }}
                  >
                    <ListItemText
                      primary={company.companies?.name || 'Unknown'}
                      secondary={
                        company.role
                          ? company.role.charAt(0).toUpperCase() + company.role.slice(1)
                          : undefined
                      }
                    />
                    {isCurrent && <CheckIcon fontSize="small" color="primary" />}
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
        </DialogContent>
      </Dialog>
    </>
  );
}
