# Jigged Documentation

Welcome to the Jigged documentation. Jigged is a data platform for small precision manufacturing shops.

## Contents

### Product Documentation
- [Product Requirements Document](prd.md) - Full PRD with functional requirements
- [System Architecture](architecture.md) - Technical architecture overview
- [Design System](design-system.md) - UI/UX design guidelines and MUI theme

### Module Specifications
See [modules/](modules/) for detailed specifications:

> **Journey specs are not a separate tier.** Each module doc carries its own journeys beside its
> current state — see [modules/inventory.md](modules/inventory.md) and
> [modules/operator-view.md](modules/operator-view.md). The two-file split was tried twice
> (`docs/inventory-flow.md`, `docs/operator-paperless-flow.md`) and **both times the journey doc
> drifted from its module doc** — the second one ended up contradicting itself about which
> journeys had shipped. Keep them in one file.
- [Customers](modules/customers.md)
- [Parts](modules/parts.md)
- [Quotes](modules/quotes.md)
- [Jobs](modules/jobs.md)
- [Routings](modules/routings.md)
- [Work Centers](modules/work-centers.md) — unifies internal + external operations (supersedes the old Operations module)
- [Vendors](modules/vendors.md)
- [Inventory](modules/inventory.md)
- [Shipments](modules/shipments.md) — feature-flagged per tenant
- [Dashboard](modules/dashboard.md)
- [Operator View](modules/operator-view.md) - Shop-floor app: screens, quantity capture, the notes read-back loop, and the operator journeys
- [Invitation System](modules/invitation-system.md)

### Testing
See [testing/](testing/) for testing strategy and guides.
