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

# Configure
cp .env.example .env.local
# Fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY

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
