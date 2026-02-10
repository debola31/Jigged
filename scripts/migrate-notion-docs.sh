#!/bin/bash
# Notion Documentation Migration Script for Jigged
# Exports all product documentation from Notion to local markdown files

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DOCS_DIR="$PROJECT_ROOT/docs"
MODULES_DIR="$DOCS_DIR/modules"
TESTING_DIR="$DOCS_DIR/testing"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Jigged Notion Documentation Migration ===${NC}"
echo "Project root: $PROJECT_ROOT"
echo "Docs directory: $DOCS_DIR"
echo ""

# Create directories
mkdir -p "$DOCS_DIR" "$MODULES_DIR" "$TESTING_DIR"

# Page ID to output file mapping
# Format: "output_path:page_id:title"
declare -a PAGES=(
  # Root level docs
  "$DOCS_DIR/prd.md:2dc5314e-8475-8144-bb28-ea4f0f89ec8c:Product Requirements Document"
  "$DOCS_DIR/prd-critique.md:2dd5314e-8475-8164-8c7f-f3ed54878961:PRD & Implementation Critique"
  "$DOCS_DIR/architecture.md:2de5314e-8475-812a-a919-d3a9afa91a18:System Architecture"
  "$DOCS_DIR/design-system.md:2dd5314e-8475-8118-b3e5-d45cf3449495:Design System"
  "$DOCS_DIR/build-sequence.md:2dc5314e-8475-8144-8aa1-f6a66ba97780:Build Sequence & Checklist"

  # Module docs
  "$MODULES_DIR/customers.md:2dc5314e-8475-813f-8b4c-d8966b8d6a33:Customers Module"
  "$MODULES_DIR/parts.md:2dc5314e-8475-8133-957d-fdb3a940d3be:Parts Module"
  "$MODULES_DIR/quotes.md:2dc5314e-8475-812a-967b-c15335f63274:Quotes Module"
  "$MODULES_DIR/jobs.md:2dc5314e-8475-8176-a163-c8b17702327d:Jobs Module"
  "$MODULES_DIR/operations.md:2dc5314e-8475-81d3-8ed0-d6f3bc09e96e:Operations Module"
  "$MODULES_DIR/dashboard.md:2dc5314e-8475-81d5-9b82-f3f1c53e95ab:Dashboard Module"
  "$MODULES_DIR/routings.md:2de5314e-8475-81a8-b87b-cce2c5d42d50:Routings Module"
  "$MODULES_DIR/inventory.md:2e45314e-8475-81d8-b3e5-f3327e2b1f11:Inventory Module"
  "$MODULES_DIR/operator-view.md:2e45314e-8475-81f3-a707-dc9d9350e528:Operator View Module"
  "$MODULES_DIR/invitation-system.md:2e95314e-8475-8139-bf34-f6f915efbdde:Invitation System & Demo Company"

  # Testing docs
  "$TESTING_DIR/README.md:2dc5314e-8475-81f9-aac7-d29e580417f1:Testing Strategy"
  "$TESTING_DIR/frontend-setup.md:2dc5314e-8475-81ce-8af4-fb9a638feffb:Frontend Testing Setup"
  "$TESTING_DIR/frontend-components.md:2dc5314e-8475-8125-9e94-ed119d5246f1:Frontend Component Tests"
  "$TESTING_DIR/backend-setup.md:2dc5314e-8475-81a1-aeaf-d41af4bf9007:Backend Testing Setup"
  "$TESTING_DIR/backend-api.md:2dc5314e-8475-8165-812d-e4f3c9c2418c:Backend API Tests"
  "$TESTING_DIR/database-rls.md:2dc5314e-8475-8145-9621-f3654fe34b1b:Database RLS Policy Tests"
  "$TESTING_DIR/e2e.md:2dc5314e-8475-81de-a957-cc190330f7b5:E2E Tests (Playwright)"
  "$TESTING_DIR/cicd.md:2dc5314e-8475-81c9-9e03-d3058629e88c:CI/CD Integration"
  "$TESTING_DIR/checklist.md:2dc5314e-8475-81ca-bd48-efbd1524b3b9:Implementation Priority & Checklist"
  "$TESTING_DIR/test-registry.md:2de5314e-8475-81e4-8692-c6f64a5837c8:Test Registry"
)

# Notion page ID to local file mapping for link replacement
declare -A PAGE_ID_TO_FILE=(
  ["2dc5314e-8475-8144-bb28-ea4f0f89ec8c"]="prd.md"
  ["2dd5314e-8475-8164-8c7f-f3ed54878961"]="prd-critique.md"
  ["2de5314e-8475-812a-a919-d3a9afa91a18"]="architecture.md"
  ["2dd5314e-8475-8118-b3e5-d45cf3449495"]="design-system.md"
  ["2dc5314e-8475-8144-8aa1-f6a66ba97780"]="build-sequence.md"
  ["2dc5314e-8475-813f-8b4c-d8966b8d6a33"]="modules/customers.md"
  ["2dc5314e-8475-8133-957d-fdb3a940d3be"]="modules/parts.md"
  ["2dc5314e-8475-812a-967b-c15335f63274"]="modules/quotes.md"
  ["2dc5314e-8475-8176-a163-c8b17702327d"]="modules/jobs.md"
  ["2dc5314e-8475-81d3-8ed0-d6f3bc09e96e"]="modules/operations.md"
  ["2dc5314e-8475-81d5-9b82-f3f1c53e95ab"]="modules/dashboard.md"
  ["2de5314e-8475-81a8-b87b-cce2c5d42d50"]="modules/routings.md"
  ["2e45314e-8475-81d8-b3e5-f3327e2b1f11"]="modules/inventory.md"
  ["2e45314e-8475-81f3-a707-dc9d9350e528"]="modules/operator-view.md"
  ["2e95314e-8475-8139-bf34-f6f915efbdde"]="modules/invitation-system.md"
  ["2dc5314e-8475-81f9-aac7-d29e580417f1"]="testing/README.md"
  ["2dc5314e-8475-81ce-8af4-fb9a638feffb"]="testing/frontend-setup.md"
  ["2dc5314e-8475-8125-9e94-ed119d5246f1"]="testing/frontend-components.md"
  ["2dc5314e-8475-81a1-aeaf-d41af4bf9007"]="testing/backend-setup.md"
  ["2dc5314e-8475-8165-812d-e4f3c9c2418c"]="testing/backend-api.md"
  ["2dc5314e-8475-8145-9621-f3654fe34b1b"]="testing/database-rls.md"
  ["2dc5314e-8475-81de-a957-cc190330f7b5"]="testing/e2e.md"
  ["2dc5314e-8475-81c9-9e03-d3058629e88c"]="testing/cicd.md"
  ["2dc5314e-8475-81ca-bd48-efbd1524b3b9"]="testing/checklist.md"
  ["2de5314e-8475-81e4-8692-c6f64a5837c8"]="testing/test-registry.md"
  ["2de5314e-8475-81f7-a81a-f50c3200b78d"]="testing/test-matrix.md"
  # Sub-pages of invitation system
  ["2e95314e-8475-8186-a863-f4c8f68c3d5d"]="modules/invitation-system.md#platform-foundation"
  ["2e95314e-8475-8151-8912-ed236a58976a"]="modules/invitation-system.md#demo-company"
  ["2e95314e-8475-81bd-b102-d04827204734"]="modules/invitation-system.md#invitation-system"
)

# Export a single page
export_page() {
  local output_file="$1"
  local page_id="$2"
  local title="$3"

  echo -e "  ${YELLOW}Exporting:${NC} $title"
  echo -e "    Page ID: $page_id"
  echo -e "    Output: $output_file"

  # Export using notion CLI
  local content
  if content=$(notion blocks children "$page_id" --recursive -f markdown 2>/dev/null); then
    # Add title header if content doesn't start with one
    if [[ ! "$content" =~ ^#[[:space:]] ]]; then
      echo "# $title" > "$output_file"
      echo "" >> "$output_file"
      echo "$content" >> "$output_file"
    else
      echo "$content" > "$output_file"
    fi
    echo -e "    ${GREEN}Success${NC}"
    return 0
  else
    echo -e "    ${RED}Failed to export${NC}"
    return 1
  fi
}

# Fix Notion links in a file
fix_links() {
  local file="$1"
  local file_dir
  file_dir=$(dirname "$file")

  echo -e "  ${YELLOW}Fixing links in:${NC} $(basename "$file")"

  # Create a temporary file for processing
  local temp_file="${file}.tmp"
  cp "$file" "$temp_file"

  # Replace [Page](page-id) style links
  for page_id in "${!PAGE_ID_TO_FILE[@]}"; do
    local target_file="${PAGE_ID_TO_FILE[$page_id]}"

    # Calculate relative path from current file to target
    local relative_path
    relative_path=$(python3 -c "import os.path; print(os.path.relpath('$DOCS_DIR/$target_file', '$file_dir'))")

    # Replace various link formats
    # Format 1: [Page](page-id)
    sed -i '' "s|\[Page\]($page_id)|[$target_file]($relative_path)|g" "$temp_file" 2>/dev/null || true
    # Format 2: [Page: Title](page-id)
    sed -i '' "s|\[Page: [^]]*\]($page_id)|[Link]($relative_path)|g" "$temp_file" 2>/dev/null || true
    # Format 3: Just the page ID as a link
    sed -i '' "s|($page_id)|($relative_path)|g" "$temp_file" 2>/dev/null || true
  done

  mv "$temp_file" "$file"
}

# Export all pages
echo -e "${GREEN}Step 1: Exporting pages from Notion${NC}"
echo ""

success_count=0
fail_count=0

for page_info in "${PAGES[@]}"; do
  IFS=':' read -r output_file page_id title <<< "$page_info"

  if export_page "$output_file" "$page_id" "$title"; then
    ((success_count++))
  else
    ((fail_count++))
  fi
  echo ""
done

echo -e "${GREEN}Export complete:${NC} $success_count succeeded, $fail_count failed"
echo ""

# Fix links in all exported files
echo -e "${GREEN}Step 2: Fixing internal links${NC}"
echo ""

for page_info in "${PAGES[@]}"; do
  IFS=':' read -r output_file page_id title <<< "$page_info"
  if [[ -f "$output_file" ]]; then
    fix_links "$output_file"
  fi
done

echo ""
echo -e "${GREEN}Step 3: Generating index files${NC}"
echo ""

# Generate main docs/README.md
cat > "$DOCS_DIR/README.md" << 'EOF'
# Jigged Documentation

Welcome to the Jigged Manufacturing ERP documentation.

## Contents

### Product Documentation
- [Product Requirements Document](prd.md) - Full PRD with functional requirements
- [PRD Critique](prd-critique.md) - Analysis and implementation critique
- [System Architecture](architecture.md) - Technical architecture overview
- [Design System](design-system.md) - UI/UX design guidelines and MUI theme

### Build Guide
- [Build Sequence](build-sequence.md) - Phase 0 implementation roadmap

### Module Specifications
See [modules/](modules/) for detailed specifications:
- [Customers](modules/customers.md)
- [Parts](modules/parts.md)
- [Quotes](modules/quotes.md)
- [Jobs](modules/jobs.md)
- [Operations](modules/operations.md)
- [Dashboard](modules/dashboard.md)
- [Routings](modules/routings.md)
- [Inventory](modules/inventory.md)
- [Operator View](modules/operator-view.md)
- [Invitation System](modules/invitation-system.md)

### Testing
See [testing/](testing/) for testing strategy and guides.

---

*Migrated from Notion on $(date +%Y-%m-%d)*
EOF

echo -e "  ${GREEN}Created:${NC} docs/README.md"

# Generate modules/README.md
cat > "$MODULES_DIR/README.md" << 'EOF'
# Module Specifications

Detailed specifications for each Jigged module.

## Modules

| Module | Description | Priority |
|--------|-------------|----------|
| [Customers](customers.md) | Customer management | Must Have |
| [Parts](parts.md) | Part catalog with revisions | Must Have |
| [Quotes](quotes.md) | Quote creation and approval | Must Have |
| [Jobs](jobs.md) | Job/work order tracking | Must Have |
| [Operations](operations.md) | Operation types and resources | Must Have |
| [Dashboard](dashboard.md) | Admin dashboard views | Must Have |
| [Routings](routings.md) | Job routing definitions | Should Have |
| [Inventory](inventory.md) | Inventory tracking | Should Have |
| [Operator View](operator-view.md) | Shop floor interface | Must Have |
| [Invitation System](invitation-system.md) | User invitations and demo company | Should Have |

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
EOF

echo -e "  ${GREEN}Created:${NC} modules/README.md"

echo ""
echo -e "${GREEN}=== Migration Complete ===${NC}"
echo ""
echo "Results:"
echo "  - $success_count pages exported"
echo "  - $fail_count pages failed"
echo "  - 2 index files created"
echo ""
echo "Next steps:"
echo "  1. Review exported files for formatting issues"
echo "  2. Check for any remaining [Page](id) links that weren't converted"
echo "  3. Update CLAUDE.md to reference local docs"
echo ""
echo "To find unconverted links:"
echo "  grep -r '\[Page\]' $DOCS_DIR"
