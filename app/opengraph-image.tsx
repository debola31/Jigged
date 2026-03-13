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
          background: 'linear-gradient(135deg, #111439 0%, #1a1f4e 40%, #111439 100%)',
          position: 'relative',
        }}
      >
        {/* Subtle accent glow */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: 600,
            height: 600,
            background: 'radial-gradient(circle at top right, rgba(70, 130, 180, 0.15), transparent 60%)',
            display: 'flex',
          }}
        />

        {/* Main content */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 40,
          }}
        >
          {/* Brand icon */}
          <div
            style={{
              width: 120,
              height: 120,
              borderRadius: 20,
              background: '#151520',
              display: 'flex',
              flexDirection: 'column',
              padding: 16,
              position: 'relative',
              flexShrink: 0,
            }}
          >
            {/* Orange bar */}
            <div
              style={{
                width: 66,
                height: 20,
                borderRadius: 4,
                background: '#D4872A',
                display: 'flex',
              }}
            />
            {/* Steel blue bar */}
            <div
              style={{
                position: 'absolute',
                left: 46,
                top: 16,
                width: 22,
                height: 62,
                background: '#4682B4',
                display: 'flex',
              }}
            />
            {/* Teal hook */}
            <div
              style={{
                position: 'absolute',
                bottom: 16,
                left: 16,
                width: 52,
                height: 30,
                borderRadius: '0 0 12px 12px',
                background: '#2BBCB3',
                display: 'flex',
              }}
            />
          </div>

          {/* Text */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                fontSize: 80,
                fontWeight: 700,
                color: '#ffffff',
                letterSpacing: '-2px',
                lineHeight: 1,
              }}
            >
              Jigged
            </div>
            <div
              style={{
                fontSize: 28,
                color: 'rgba(255, 255, 255, 0.5)',
                fontWeight: 400,
                marginTop: 8,
              }}
            >
              Manufacturing Operations System
            </div>
          </div>
        </div>

        {/* Tagline */}
        <div
          style={{
            fontSize: 24,
            color: 'rgba(255, 255, 255, 0.7)',
            fontWeight: 500,
            marginTop: 48,
            letterSpacing: '0.5px',
          }}
        >
          Your Shop Floor, Finally Under Control
        </div>

        {/* Domain */}
        <div
          style={{
            position: 'absolute',
            bottom: 32,
            fontSize: 18,
            color: 'rgba(255, 255, 255, 0.3)',
            fontWeight: 400,
            letterSpacing: '2px',
          }}
        >
          jigged.app
        </div>
      </div>
    ),
    { ...size }
  );
}
