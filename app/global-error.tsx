'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
    console.error('Global error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          backgroundColor: '#111439',
          color: '#ffffff',
          fontFamily:
            "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
        }}
      >
        <div
          style={{
            maxWidth: 480,
            width: '100%',
            padding: 32,
            textAlign: 'center',
            backgroundColor: 'rgba(255, 255, 255, 0.06)',
            borderRadius: 16,
            margin: 16,
          }}
        >
          <div
            style={{
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: '-0.03em',
              marginBottom: 24,
            }}
          >
            Jigged
          </div>

          <div style={{ fontSize: 48, marginBottom: 16 }}>!</div>

          <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>
            Something Went Wrong
          </h1>

          <p
            style={{
              fontSize: 16,
              color: 'rgba(255, 255, 255, 0.7)',
              marginBottom: 32,
              lineHeight: 1.5,
            }}
          >
            A critical error occurred. Please reload the page or return to the
            home page.
          </p>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <button
              onClick={reset}
              style={{
                padding: '14px 24px',
                fontSize: 16,
                fontWeight: 600,
                color: '#ffffff',
                backgroundColor: '#4682B4',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                minHeight: 48,
              }}
            >
              Try Again
            </button>
            {/*
              global-error.tsx replaces the root layout when rendered, so
              the Next.js router context that <Link /> depends on isn't
              available. Plain <a href> is the recommended fallback for
              navigating out of an unrecoverable error state.
            */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              style={{
                padding: '14px 24px',
                fontSize: 16,
                fontWeight: 600,
                color: '#4682B4',
                backgroundColor: 'transparent',
                border: '1px solid rgba(70, 130, 180, 0.5)',
                borderRadius: 8,
                textDecoration: 'none',
                display: 'block',
                minHeight: 48,
                lineHeight: '20px',
                boxSizing: 'border-box',
              }}
            >
              Go to Home Page
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
