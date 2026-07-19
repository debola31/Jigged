# Module Specifications

Detailed specifications for each Jigged module.

## Modules

| Module | Description | Priority |
|--------|-------------|----------|
| [Customers](customers.md) | Customer management | Must Have |
| [Parts](parts.md) | Part catalog with revisions | Must Have |
| [Quotes](quotes.md) | Quote creation and approval | Must Have |
| [Jobs](jobs.md) | Job/work order tracking | Must Have |
| Operations | Folded into [Work Centers](work-centers.md) | — |
| [Dashboard](dashboard.md) | Admin dashboard views | Must Have |
| [Routings](routings.md) | Job routing definitions | Should Have |
| [Inventory](inventory.md) | Inventory tracking | Should Have |
| [Operator View](operator-view.md) | Shop floor interface | Must Have |
| [Shipments](shipments.md) | Packing slips + fulfillment status | Built |
| [Invitation System](invitation-system.md) | User invitations and referrals | Should Have |
| [Data Import](data-import.md) | Guided onboarding import (Upload → Map → Review & Fix → Import); idempotent natural-identity upsert. See also the [Phase 2 design](data-import-phase2-design.md). | Built |
| [Demo Mode](demo-mode.md) | Demo mode with hidden demo company | Should Have |
| [AI Insights & Charts](ai-insights.md) | AI-powered dashboard insights and natural language queries | Should Have |

## Build Order

Recommended implementation sequence:
1. Customers (foundation)
2. Parts (product catalog)
3. Quotes (sales pipeline)
4. Jobs (core workflow)
5. Operations (shop floor)
6. Dashboard (visibility)
7. Routings (advanced)
8. Inventory (tracking)
9. Operator View (shop interface)
10. Invitation System (growth)
11. Demo Mode (onboarding)
12. AI Insights & Charts (intelligence)
