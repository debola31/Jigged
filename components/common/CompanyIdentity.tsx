'use client';

import { useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Avatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';

/**
 * A company's initials, from the first letter of up to two words.
 *
 * Moved here from `CompanySwitcher` unchanged, so no existing row changes what it shows. Company
 * names are NOT person names — `lib/initials.ts` handles those and stays deliberately separate;
 * that file's own comment explains why.
 */
export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Deterministic avatar colour, keyed on the first character.
 *
 * Moved here from `CompanySwitcher` unchanged. It is a weak hash — two shops starting with the same
 * letter always collide — which is part of why a real logo is worth showing where one exists.
 */
export function getAvatarColor(name: string): string {
  const colors = [
    '#4682B4', '#6FA3D8', '#2E5A8A', '#3B82F6',
    '#8B5CF6', '#10B981', '#F59E0B', '#EF4444'
  ];
  const index = name.charCodeAt(0) % colors.length;
  return colors[index];
}

interface CompanyIdentityProps {
  /** The company name. Also the logo's alt text, since the logo replaces it visually. */
  name: string;
  /** Role line under the name. Omit for surfaces that don't show one (the collapsed trigger). */
  role?: string | null;
  /**
   * A signed URL for a logo that CARRIES THE COMPANY NAME, or null.
   *
   * The caller is responsible for that condition — `useCompanyLogos` only mints URLs for companies
   * whose `settings.logo_includes_name` is true. Passing a URL for a name-less emblem would hide
   * the name behind artwork that cannot replace it.
   */
  logoUrl?: string | null;
  /** `row` for a list item, `trigger` for the compact always-visible sidebar row. */
  variant?: 'row' | 'trigger';
  /** The caller's own chrome — a check mark, a caret. Stays put in both modes. */
  trailing?: ReactNode;
  /** Renders the name in semibold, for the selected row. */
  emphasised?: boolean;
}

const ROLE_SX = { fontSize: '0.75rem', color: 'rgba(255, 255, 255, 0.5)' } as const;

/**
 * One company's mark and label — the wordmark where a logo can do the naming, today's coloured
 * initials everywhere else.
 *
 * **The logo replaces the name; it never sits beside it.** A shop whose logo is its name would
 * otherwise read it twice, which is the same reason the PDF header suppresses the printed name
 * (`drawShopHeaderBlock`). Shared by the workspace switcher and the login picker so the two can't
 * drift.
 *
 * **The fallback is not optional.** With the name suppressed, a logo that won't load leaves a row
 * with nothing to identify it — so an image error drops this straight back to initials + name,
 * which is exactly the row the app shows today. Signed URLs expire and the bucket is private, so
 * this path runs in normal use, not just in a failure. Tracking the failed URL (rather than a
 * boolean) means a re-minted URL is retried rather than written off for the life of the component.
 */
export default function CompanyIdentity({
  name,
  role,
  logoUrl,
  variant = 'row',
  trailing,
  emphasised = false,
}: CompanyIdentityProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showLogo = Boolean(logoUrl) && failedUrl !== logoUrl;

  /**
   * The tallest a logo may draw. It is a CAP, not a height: the image keeps its own aspect ratio
   * and the plate takes its size from the result.
   *
   * A wide wordmark (Contour is about 7:1) runs out of sidebar long before it reaches this, so it
   * is width-bound and the cap never bites. A squarer mark (L&L is nearer 1.6:1) is height-bound,
   * and this is what decides how big it gets to be.
   */
  const maxLogoHeight = variant === 'trigger' ? 44 : 52;

  const logo = (
    <Box
      component="img"
      src={logoUrl ?? undefined}
      alt={name}
      onError={() => setFailedUrl(logoUrl ?? null)}
      sx={{
        maxWidth: '100%',
        maxHeight: maxLogoHeight,
        width: 'auto',
        height: 'auto',
        objectFit: 'contain',
        display: 'block',
      }}
    />
  );

  /**
   * A white plate, for the same reason the settings preview forces one: shops upload the file they
   * hand their printer — dark ink on a transparent ground — which is invisible on the indigo chrome.
   *
   * **The plate hugs the artwork; the artwork does not rattle around inside the plate.** A fixed
   * box has to be tall enough for the tallest logo and wide enough for the widest, which leaves
   * every other logo stranded in white and looking smaller than it is. Sizing to content instead
   * means the padding is the only white, so each shop's mark draws as large as its own proportions
   * allow.
   */
  const plateSx = {
    bgcolor: 'common.white',
    borderRadius: 1.5,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 'fit-content',
    maxWidth: '100%',
    p: 0.75,
  } as const;

  if (variant === 'trigger') {
    if (showLogo) {
      // The wrapper takes the row's free space so the caret keeps its own width — the sidebar is
      // only 240px and a plate that grabbed all of it would push the caret off the edge. The plate
      // sits at the start of that space, on the same left rail as the avatar it replaces.
      return (
        <>
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex' }}>
            <Box sx={plateSx}>{logo}</Box>
          </Box>
          {trailing}
        </>
      );
    }

    return (
      <>
        <Avatar
          sx={{
            width: 36,
            height: 36,
            bgcolor: getAvatarColor(name),
            fontSize: '0.875rem',
            fontWeight: 600,
          }}
        >
          {getInitials(name)}
        </Avatar>
        <Box sx={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 600,
              color: 'white',
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              lineHeight: 1.3,
            }}
          >
            {name}
          </Typography>
        </Box>
        {trailing}
      </>
    );
  }

  if (showLogo) {
    // The band spans the row, so the role line carries the trailing chrome: with no name there is
    // no baseline for a check mark to sit against.
    return (
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex' }}>
          <Box sx={plateSx}>{logo}</Box>
        </Box>
        {(role || trailing) && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.875 }}>
            {role && <Typography sx={{ ...ROLE_SX, flex: 1, minWidth: 0 }}>{role}</Typography>}
            {trailing}
          </Box>
        )}
      </Box>
    );
  }

  return (
    <>
      <ListItemIcon>
        <Avatar
          sx={{
            width: 40,
            height: 40,
            bgcolor: getAvatarColor(name),
            fontSize: '0.9rem',
            fontWeight: 600,
          }}
        >
          {getInitials(name)}
        </Avatar>
      </ListItemIcon>
      <ListItemText
        primary={name}
        secondary={role}
        slotProps={{
          primary: {
            sx: { fontWeight: emphasised ? 600 : 500, fontSize: '0.95rem', color: 'white' },
          },
          secondary: { sx: ROLE_SX },
        }}
      />
      {trailing}
    </>
  );
}
