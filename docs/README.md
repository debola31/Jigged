# Jigged Documentation

Welcome to the Jigged documentation. Jigged is a data platform for small precision manufacturing shops.

## Contents

### Product Documentation
- [Product Requirements Document](prd.md) - Full PRD with functional requirements
- [System Architecture](architecture.md) - Technical architecture overview
- [Design System](design-system.md) - UI/UX design guidelines and MUI theme

### Journey Specs
- [Operator Paperless Flow](operator-paperless-flow.md) - Operator journeys and the decisions bounding them

> Inventory's journey spec is **not** here — it lives inside
> [modules/inventory.md](modules/inventory.md), which carries both current state and target
> journeys in one document.

### Module Specifications
See [modules/](modules/) for detailed specifications:
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
- [Operator View](modules/operator-view.md)
- [Invitation System](modules/invitation-system.md)

### Testing
See [testing/](testing/) for testing strategy and guides.
