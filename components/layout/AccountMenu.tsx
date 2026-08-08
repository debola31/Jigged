'use client';

/**
 * Who you are signed in as, in the office header — and the account actions that belong with it.
 *
 * ## The gap this closes
 *
 * The office surface had no way to answer "which account am I in as?". The shop floor did, and
 * still does: `components/operator/OperatorAccountBlock.tsx` shows avatar, name, company and email
 * in one row. The office header only ever had `Welcome, {firstName}` read from
 * `user.user_metadata.first_name` — a key written by exactly two sign-up paths, so for an account
 * created any other way the greeting rendered as nothing at all. Silent, and impossible to notice
 * as a bug rather than a design choice, because a missing greeting looks like no greeting.
 * `hooks/useCurrentMember.ts` documents the source swap that fixes it.
 *
 * Top-right avatar-into-menu is the settled convention (NN/g heuristic #4, "follow platform and
 * industry conventions"), and knowing which account is acting is system status, not decoration
 * (heuristic #1). The sidebar's `CompanySwitcher` owns *workspace* identity at top-left; this owns
 * *person* identity at top-right. Two slots, two owners, no competition.
 *
 * ## Why the name is on screen and not only inside the menu
 *
 * A bare avatar is a bare glyph, and this repo has already rejected that argument twice for this
 * exact header — `components/layout/Header.tsx` keeps "Shop floor" labelled at every width, and
 * `app/operator/[companyId]/layout.tsx` says why: "our audience skews 50-60, where icon recognition
 * is measurably worse". An avatar you must click to decode does not answer the question that
 * prompted this; the name beside it does, at zero clicks. It hides under `md`, which is exactly
 * where `Welcome, {firstName}` already hid, so no width loses anything it had.
 *
 * ## Why Sign out moved into a menu
 *
 * `docs/interaction-standards.md` §1 says the office surface should not bury a destructive control
 * behind a kebab. That rule is about RECORD DELETES shown red-at-rest, and the two things it
 * protects both survive here: Sign out is last, and it is `error.main` at rest (which the old bare
 * header button was not — it was grey-until-hover, a deviation this fixes). Signing out is also
 * recoverable by signing back in, which a delete is not.
 *
 * It is a net safety gain at narrow widths. The old header put a bare sign-out `IconButton`
 * immediately beside the Shop floor button, so one mis-tap ended the session — the Fitts's-law slip
 * `app/operator/[companyId]/layout.tsx` refuses to allow in the operator header. Now the same
 * mis-tap opens a menu.
 *
 * No confirmation dialog, for the reason `OperatorAccountBlock` gives: a dialog on a recoverable
 * action is the confirmation-fatigue trap that strips the dialogs that matter of their force.
 */

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import LockResetIcon from '@mui/icons-material/LockReset';
import LogoutIcon from '@mui/icons-material/Logout';
import PersonIcon from '@mui/icons-material/Person';

import { useAuth } from '@/components/providers/AuthProvider';
import { useCurrentMember } from '@/hooks/useCurrentMember';
import { initials } from '@/lib/initials';

/** `admin | user | operator` as it should read to a person. */
const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  user: 'User',
  operator: 'Operator',
};

/**
 * The identity block at the top of the menu — the actual answer to "who am I signed in as".
 *
 * Not a `MenuItem`: it is a statement, not an action, so making it selectable would put a no-op at
 * the first stop of every keyboard user's arrow-down. `muiSkipListHighlight` is MUI's own mechanism
 * for this (`Divider` and `ListSubheader` both set it) — without it `MenuList` picks the first
 * non-disabled child as `activeItemIndex` and clones `autoFocus` + `tabIndex={0}` onto it, which
 * would make this block focusable and steal the menu's opening focus.
 *
 * `component="li"` because `MenuList` renders a `<ul>` and a bare `<div>` in there is invalid HTML.
 */
function AccountIdentity({
  name,
  email,
  role,
}: {
  name: string | null;
  email: string | null;
  role: string | null;
}) {
  // Name leads when we have one. When we don't, the email is promoted rather than padded out with a
  // placeholder — inventing a name from the email's local part would be inventing identity, which
  // is the opposite of what this component is for.
  const primary = name ?? email;
  const secondary = name ? email : null;
  const roleLabel = role ? (ROLE_LABELS[role] ?? role) : null;

  return (
    <Box
      component="li"
      sx={{ px: 2, py: 1.5, display: 'flex', alignItems: 'center', gap: 1.5, maxWidth: 320 }}
    >
      <Avatar sx={{ bgcolor: 'primary.main', width: 40, height: 40, flexShrink: 0 }}>
        {name ? initials(name) : <PersonIcon />}
      </Avatar>
      {/* minWidth: 0 is what lets the lines below truncate instead of forcing the menu wider. */}
      <Box sx={{ minWidth: 0 }}>
        {primary && (
          <Typography sx={{ fontWeight: 600 }} noWrap>
            {primary}
          </Typography>
        )}
        {secondary && (
          // body2, not the caption the operator row uses for the same field. On the office surface
          // the email is the load-bearing disambiguator between two accounts, and #C8CCD4 at 14px
          // clears 4.5:1 where 12px is working harder than it needs to for a 50-60 audience.
          <Typography variant="body2" color="text.secondary" noWrap>
            {secondary}
          </Typography>
        )}
        {roleLabel && (
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{ display: 'block' }}
          >
            {roleLabel}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
AccountIdentity.muiSkipListHighlight = true;

export default function AccountMenu({ isMobile = false }: { isMobile?: boolean }) {
  const router = useRouter();
  const { signOut } = useAuth();
  const { name, email, role } = useCurrentMember();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const id = useId();
  const triggerId = `${id}-account-trigger`;
  const menuId = `${id}-account-menu`;

  const open = Boolean(anchorEl);
  const close = () => setAnchorEl(null);

  const handleSignOut = async () => {
    close();
    // Scope stays AuthProvider's `local` default on purpose: signing out at the office must not
    // revoke the same person's session on the shop-floor phone in their pocket.
    await signOut();
    router.replace('/');
  };

  const label = name ?? email;

  return (
    <>
      <Button
        id={triggerId}
        onClick={(e) => setAnchorEl(e.currentTarget)}
        // Named even when the name is on screen beside it, because under `md` the avatar is all
        // that is left and an unlabelled one says nothing. The visible text stays a substring of
        // the accessible name (WCAG 2.5.3, Label in Name).
        aria-label={label ? `Account: ${label}` : 'Account'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        sx={{
          // The theme floors every Button at minHeight 48. The width needs bringing DOWN: MUI's
          // own `minWidth: 64` plus the theme's 20px side padding would reserve ~72px for a 32px
          // avatar, and at 390px the header title is already truncating against this cluster.
          // 48 is the design-system floor, so this is as tight as the control is allowed to get.
          px: 1,
          minWidth: 48,
          gap: 1,
          flexShrink: 0,
          // White rather than the 70% white its neighbours use: this is identity, and 70% white on
          // the header's top-right bloom does not clear 4.5:1 at body2.
          color: 'common.white',
          // Same hover as the Shop floor button two controls to the left, so the right-hand cluster
          // reads as one thing.
          '&:hover': { bgcolor: 'rgba(70, 130, 180, 0.16)' },
        }}
      >
        <Avatar sx={{ bgcolor: 'primary.main', width: 32, height: 32 }}>
          {name ? initials(name) : <PersonIcon fontSize="small" />}
        </Avatar>
        {!isMobile && label && (
          <>
            <Typography variant="body2" component="span" noWrap sx={{ maxWidth: 160 }}>
              {label}
            </Typography>
            <KeyboardArrowDownIcon fontSize="small" />
          </>
        )}
      </Button>

      <Menu
        id={menuId}
        anchorEl={anchorEl}
        open={open}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ list: { 'aria-labelledby': triggerId } }}
      >
        <AccountIdentity name={name} email={email} role={role} />
        <Divider />
        <MenuItem
          component={Link}
          href="/change-password"
          onClick={close}
          sx={{ minHeight: 48 }}
        >
          <ListItemIcon>
            <LockResetIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Change password</ListItemText>
        </MenuItem>
        <Divider />
        {/* Last, and error-coloured at rest — docs/design-system.md names Logout destructive, and
            docs/interaction-standards.md puts the destructive option at the end, away from the
            benign ones. Same shape as components/notes/NoteActionsMenu.tsx. */}
        <MenuItem onClick={handleSignOut} sx={{ minHeight: 48, color: 'error.main' }}>
          <ListItemIcon>
            <LogoutIcon fontSize="small" color="error" />
          </ListItemIcon>
          <ListItemText>Sign out</ListItemText>
        </MenuItem>
      </Menu>
    </>
  );
}
