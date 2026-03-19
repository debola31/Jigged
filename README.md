# Jigged - Manufacturing ERP

> Web-based ERP for small-scale precision manufacturing shops

## Overview

Jigged is an Enterprise Resource Planning tool designed for small U.S. machine shops that struggle with rigid legacy ERP systems like Tangle and E2 JobBoss. It centralizes work orders, inventory tracking, and shop-floor status into focused consoles, with AI-assisted insights to surface bottlenecks and gamified experiences for operators to encourage consistent data capture.

### Problem Statement

Small machine shop owners face three core challenges that legacy ERP systems fail to address:

1. **Inflexible Inventory Management** - Cannot easily record material depletion in granular and bulk measurements
2. **Limited Visibility** - No integrated view of work in progress tied to revenue and labor
3. **Operator Compliance Gaps** - Struggle to get consistent logging of material usage, time tracking, and quality checkpoints

## Features

### Implemented (Phase 0)

- **Customer Management** - Full CRUD, CSV import/export with AI-powered field mapping, AG Grid views with search, sort, and bulk operations
- **Parts Catalog** - Volume-based pricing tiers, material cost tracking, customer association
- **Quotes** - Create/edit quotes linked to customers and parts, status workflow (Draft/Pending/Approved/Rejected/Expired), convert to jobs
- **Operations & Resources** - Operation types organized in resource groups, labor rate tracking
- **Authentication** - Supabase Auth with multi-tenant company access and automatic company routing

### Roadmap

- Job/Work Order execution and real-time tracking
- Inventory management with flexible unit conversions
- Shop floor operator interface with gamification (streaks, achievements)
- AI-driven insights and bottleneck detection
- Reorder alerts and inventory forecasting

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16+, TypeScript, Material-UI v7+, AG Grid |
| Backend | FastAPI (Python) |
| Database | PostgreSQL on Supabase |
| Auth | Supabase Auth |
| Hosting | Vercel |

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm
- Python 3.11+

### Installation

```bash
# Clone and install
git clone <repo>
cd jigged
pnpm install

# Set environment variables
cp .env.example .env.local
# Edit .env.local with Supabase credentials:
# NEXT_PUBLIC_SUPABASE_URL=...
# NEXT_PUBLIC_SUPABASE_ANON_KEY=...

# Run frontend dev server
pnpm dev

# Run backend dev server (separate terminal)
cd api && python index.py
```

Open [http://localhost:3000](http://localhost:3000) to view the application.

## Project Structure

```
/
├── app/                        # Next.js App Router
│   ├── login/                  # Authentication pages
│   ├── signup/
│   ├── select-company/         # Multi-tenant company selector
│   └── dashboard/[companyId]/  # Protected routes
│       ├── customers/          # Customer management
│       ├── parts/              # Parts catalog
│       ├── quotes/             # Quote creation
│       ├── operations/         # Operations & resources
│       └── jobs/               # Job tracking
├── components/                 # React components
├── lib/                        # Utilities (theme, supabase)
├── api/                        # FastAPI backend
│   └── index.py
└── CLAUDE.md                   # Developer instructions
```

## Multi-Tenancy

Jigged is a multi-tenant SaaS where each company's data is isolated. All routes include a `companyId` parameter:

- `/dashboard/{companyId}`
- `/customers/{companyId}`
- `/parts/{companyId}`

Users can belong to multiple companies and switch between them.

## Documentation

Product requirements and module specifications are maintained in Notion. See `CLAUDE.md` for Notion CLI usage and document references including:

- Product Requirements Document (PRD)
- Phase 0 module specifications (Customers, Parts, Quotes, Jobs, Operations, Dashboard)
- Build sequence and implementation checklists
- Testing strategy

## License

Proprietary - Contour Tool Inc
