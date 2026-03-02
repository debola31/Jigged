import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'Jigged — Manufacturing Operations System';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #111439 0%, #4682B4 50%, #111439 100%)',
        }}
      >
        <div
          style={{
            fontSize: 72,
            fontWeight: 700,
            color: '#ffffff',
            letterSpacing: '-1px',
            marginBottom: 16,
          }}
        >
          Jigged
        </div>
        <div
          style={{
            fontSize: 28,
            color: 'rgba(255, 255, 255, 0.6)',
            fontWeight: 400,
          }}
        >
          Manufacturing Operations System
        </div>
      </div>
    ),
    { ...size }
  );
}
