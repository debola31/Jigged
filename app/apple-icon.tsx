import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 180,
          height: 180,
          background: '#111439',
          borderRadius: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg
          viewBox="0 0 32 32"
          width="120"
          height="120"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* L-bracket body */}
          <path
            d="M5 4 L13 4 L13 12.5 L16.5 16 L27 16 L27 27 L5 27 Z"
            fill="#4682B4"
          />
          {/* Registration crosshair - vertical */}
          <line
            x1="22"
            y1="5"
            x2="22"
            y2="12"
            stroke="white"
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity="0.7"
          />
          {/* Registration crosshair - horizontal */}
          <line
            x1="18"
            y1="8.5"
            x2="26"
            y2="8.5"
            stroke="white"
            strokeWidth="1.2"
            strokeLinecap="round"
            opacity="0.7"
          />
          {/* Datum point */}
          <circle cx="22" cy="8.5" r="1.5" fill="white" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
