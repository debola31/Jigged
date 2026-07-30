# Jigged

> A data platform for small precision manufacturing shops.

Jigged centralizes jobs, parts, quotes, inventory, and shop-floor status into focused consoles, with AI-assisted insights and gamified operator workflows that encourage consistent data capture

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16+, TypeScript, Material-UI v7+, AG Grid |
| Backend | FastAPI (Python) |
| Database | PostgreSQL on Supabase |
| Auth | Supabase Auth |
| Hosting | Vercel |

## Quick Start

```bash
# Install
pnpm install

# Configure — create .env.local and fill in:
#   NEXT_PUBLIC_SUPABASE_URL          Supabase project URL
#   NEXT_PUBLIC_SUPABASE_ANON_KEY     Supabase anon/publishable key
#   NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN PostHog project token (product analytics)
#   NEXT_PUBLIC_SENTRY_DSN            Sentry DSN, Next.js server + edge runtimes
#   SENTRY_DSN                        Sentry DSN, FastAPI backend
# Observability is optional locally: both SDKs are disabled outside a
# production build, so a missing DSN changes nothing in dev.

# Run
pnpm dev                       # frontend on :3000
cd api && python index.py      # backend on :8000 (separate terminal)
```

## Documentation

All product and engineering documentation lives in [`docs/`](docs/):

- [Product Requirements](docs/prd.md)
- [System Architecture](docs/architecture.md)
- [Design System](docs/design-system.md)
- [Module specifications](docs/modules/)
- [Testing strategy](docs/testing/)

Developer instructions for Claude Code agents are in [CLAUDE.md](CLAUDE.md).

## License

Proprietary. All rights reserved.
