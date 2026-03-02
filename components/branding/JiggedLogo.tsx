'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import JiggedIcon from './JiggedIcon';

type LogoSize = 'small' | 'medium' | 'large';

interface JiggedLogoProps {
  size?: LogoSize;
  showWordmark?: boolean;
  variant?: 'dark' | 'light';
}

const sizeMap = {
  small: { icon: 26, fontSize: '16px', gap: '10px' },
  medium: { icon: 32, fontSize: '20px', gap: '12px' },
  large: { icon: 48, fontSize: '30px', gap: '14px' },
};

export default function JiggedLogo({
  size = 'medium',
  showWordmark = true,
  variant = 'dark',
}: JiggedLogoProps) {
  const config = sizeMap[size];
  const textColor = variant === 'dark' ? '#FFFFFF' : '#1a2744';

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: config.gap }}>
      <JiggedIcon size={config.icon} variant={variant} />
      {showWordmark && (
        <Typography
          component="span"
          sx={{
            fontSize: config.fontSize,
            fontWeight: 700,
            color: textColor,
            letterSpacing: '-0.03em',
          }}
        >
          Jigged
        </Typography>
      )}
    </Box>
  );
}
