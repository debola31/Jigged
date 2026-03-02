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
          background: '#151520',
          borderRadius: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg
          viewBox="0 0 64 64"
          width="140"
          height="140"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <rect x="14" y="10" width="30" height="10" rx="2" fill="#D4872A" />
          <rect x="30" y="10" width="10" height="32" rx="0" fill="#4682B4" />
          <path
            d="M40 42 L40 54 L26 54 Q14 54 14 42 L24 42 Q30 42 30 48 L30 54"
            fill="#2BBCB3"
          />
        </svg>
      </div>
    ),
    { ...size }
  );
}
