'use client';

import Box from '@mui/material/Box';

interface JiggedIconProps {
  size?: number;
  color?: string;
  crosshairColor?: string;
}

export default function JiggedIcon({
  size = 32,
  color = '#4682B4',
  crosshairColor = '#FFFFFF',
}: JiggedIconProps) {
  return (
    <Box
      component="svg"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Jigged logo"
      sx={{ width: size, height: size, flexShrink: 0 }}
    >
      {/* L-bracket body with chamfered inner corner */}
      <path
        d="M4 2 L14 2 L14 13 L18 17 L30 17 L30 30 L4 30 Z"
        fill={color}
      />
      {/* Registration crosshair - vertical */}
      <line
        x1="24"
        y1="3"
        x2="24"
        y2="12"
        stroke={crosshairColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.7"
      />
      {/* Registration crosshair - horizontal */}
      <line
        x1="19"
        y1="7.5"
        x2="29"
        y2="7.5"
        stroke={crosshairColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.7"
      />
      {/* Datum point */}
      <circle cx="24" cy="7.5" r="2" fill={crosshairColor} />
    </Box>
  );
}
