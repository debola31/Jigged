"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 24,
          fontFamily: "'DM Sans', sans-serif",
          color: "#fff",
          background: "#0a1628",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
        }}
      >
        <div style={{ maxWidth: 480, textAlign: "center" }}>
          <h2 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>
            Something went wrong
          </h2>
          <p
            style={{
              fontSize: 16,
              color: "rgba(255,255,255,0.7)",
              marginBottom: 24,
            }}
          >
            {error.message || "An unexpected error occurred"}
          </p>
          <button
            onClick={reset}
            style={{
              padding: "12px 32px",
              fontSize: 16,
              fontWeight: 500,
              cursor: "pointer",
              background: "#90caf9",
              border: "none",
              borderRadius: 8,
              color: "#0a1628",
            }}
          >
            Try Again
          </button>
        </div>
      </body>
    </html>
  );
}
