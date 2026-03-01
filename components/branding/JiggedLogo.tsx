'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import JiggedIcon from './JiggedIcon';

type LogoSize = 'small' | 'medium' | 'large';

interface JiggedLogoProps {
  size?: LogoSize;
  showWordmark?: boolean;
  variant?: 'light' | 'dark';
}

const sizeMap = {
  small: { icon: 24, variant: 'subtitle1' as const, gap: 1 },
  medium: { icon: 32, variant: 'h5' as const, gap: 1.5 },
  large: { icon: 48, variant: 'h4' as const, gap: 2 },
};

export default function JiggedLogo({
  size = 'medium',
  showWordmark = true,
  variant = 'light',
}: JiggedLogoProps) {
  const config = sizeMap[size];
  const textColor = variant === 'light' ? 'primary.main' : '#111439';
  const crosshairColor = variant === 'light' ? '#FFFFFF' : '#111439';

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: config.gap }}>
      <JiggedIcon size={config.icon} crosshairColor={crosshairColor} />
      {showWordmark && (
        <Typography
          variant={config.variant}
          component="span"
          sx={{
            fontWeight: 700,
            color: textColor,
            letterSpacing: '-0.5px',
          }}
        >
          Jigged
        </Typography>
      )}
    </Box>
  );
}
