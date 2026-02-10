#!/usr/bin/env python3
"""Fix remaining Notion page links in exported markdown files."""

import os
import re
from pathlib import Path

# Mapping of Notion page IDs to local file paths (relative to docs/)
PAGE_ID_TO_FILE = {
    "2dc5314e-8475-8144-bb28-ea4f0f89ec8c": ("prd.md", "Product Requirements Document"),
    "2dd5314e-8475-8164-8c7f-f3ed54878961": ("prd-critique.md", "PRD Critique"),
    "2de5314e-8475-812a-a919-d3a9afa91a18": ("architecture.md", "System Architecture"),
    "2dd5314e-8475-8118-b3e5-d45cf3449495": ("design-system.md", "Design System"),
    "2dc5314e-8475-8144-8aa1-f6a66ba97780": ("build-sequence.md", "Build Sequence"),
    "2dc5314e-8475-813f-8b4c-d8966b8d6a33": ("modules/customers.md", "Customers Module"),
    "2dc5314e-8475-8133-957d-fdb3a940d3be": ("modules/parts.md", "Parts Module"),
    "2dc5314e-8475-812a-967b-c15335f63274": ("modules/quotes.md", "Quotes Module"),
    "2dc5314e-8475-8176-a163-c8b17702327d": ("modules/jobs.md", "Jobs Module"),
    "2dc5314e-8475-81d3-8ed0-d6f3bc09e96e": ("modules/operations.md", "Operations Module"),
    "2dc5314e-8475-81d5-9b82-f3f1c53e95ab": ("modules/dashboard.md", "Dashboard Module"),
    "2de5314e-8475-81a8-b87b-cce2c5d42d50": ("modules/routings.md", "Routings Module"),
    "2e45314e-8475-81d8-b3e5-f3327e2b1f11": ("modules/inventory.md", "Inventory Module"),
    "2e45314e-8475-81f3-a707-dc9d9350e528": ("modules/operator-view.md", "Operator View Module"),
    "2e95314e-8475-8139-bf34-f6f915efbdde": ("modules/invitation-system.md", "Invitation System"),
    "2dc5314e-8475-81f9-aac7-d29e580417f1": ("testing/README.md", "Testing Strategy"),
    "2dc5314e-8475-81ce-8af4-fb9a638feffb": ("testing/frontend-setup.md", "Frontend Testing Setup"),
    "2dc5314e-8475-8125-9e94-ed119d5246f1": ("testing/frontend-components.md", "Frontend Component Tests"),
    "2dc5314e-8475-81a1-aeaf-d41af4bf9007": ("testing/backend-setup.md", "Backend Testing Setup"),
    "2dc5314e-8475-8165-812d-e4f3c9c2418c": ("testing/backend-api.md", "Backend API Tests"),
    "2dc5314e-8475-8145-9621-f3654fe34b1b": ("testing/database-rls.md", "Database RLS Tests"),
    "2dc5314e-8475-81de-a957-cc190330f7b5": ("testing/e2e.md", "E2E Tests"),
    "2dc5314e-8475-81c9-9e03-d3058629e88c": ("testing/cicd.md", "CI/CD Integration"),
    "2dc5314e-8475-81ca-bd48-efbd1524b3b9": ("testing/checklist.md", "Implementation Checklist"),
    "2de5314e-8475-81e4-8692-c6f64a5837c8": ("testing/test-registry.md", "Test Registry"),
    "2de5314e-8475-81f7-a81a-f50c3200b78d": ("testing/test-matrix.md", "Test Matrix"),
    # Sub-pages of invitation system (link to anchors)
    "2e95314e-8475-8186-a863-f4c8f68c3d5d": ("modules/invitation-system.md#platform-foundation", "Platform Foundation"),
    "2e95314e-8475-8151-8912-ed236a58976a": ("modules/invitation-system.md#demo-company", "Demo Company"),
    "2e95314e-8475-81bd-b102-d04827204734": ("modules/invitation-system.md#invitation-system", "Invitation System"),
}

def get_relative_path(from_file: Path, to_file: str, docs_dir: Path) -> str:
    """Calculate relative path from one file to another."""
    from_dir = from_file.parent
    to_path = docs_dir / to_file

    try:
        return os.path.relpath(to_path, from_dir)
    except ValueError:
        return to_file

def fix_links_in_file(file_path: Path, docs_dir: Path) -> int:
    """Fix all Notion page links in a file. Returns count of fixes."""

    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    original_content = content
    fix_count = 0

    for page_id, (target_file, title) in PAGE_ID_TO_FILE.items():
        relative_path = get_relative_path(file_path, target_file, docs_dir)

        # Pattern 1: [Page: Title](page-id)
        pattern1 = rf'\[Page: [^\]]*\]\({re.escape(page_id)}\)'
        replacement1 = f'[{title}]({relative_path})'
        content, count1 = re.subn(pattern1, replacement1, content)
        fix_count += count1

        # Pattern 2: [Page](page-id)
        pattern2 = rf'\[Page\]\({re.escape(page_id)}\)'
        replacement2 = f'[{title}]({relative_path})'
        content, count2 = re.subn(pattern2, replacement2, content)
        fix_count += count2

    if content != original_content:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"  Fixed {fix_count} links in {file_path.name}")

    return fix_count

def main():
    script_dir = Path(__file__).parent
    docs_dir = script_dir.parent / "docs"

    print("=== Fixing Notion Page Links ===")
    print(f"Docs directory: {docs_dir}")
    print()

    total_fixes = 0

    # Process all markdown files
    for md_file in docs_dir.rglob("*.md"):
        fixes = fix_links_in_file(md_file, docs_dir)
        total_fixes += fixes

    print()
    print(f"Total links fixed: {total_fixes}")

    # Verify no remaining [Page] links
    print()
    print("Checking for remaining unconverted links...")
    remaining = []
    for md_file in docs_dir.rglob("*.md"):
        with open(md_file, 'r', encoding='utf-8') as f:
            content = f.read()
        matches = re.findall(r'\[Page[:\]].*?\)', content)
        if matches:
            remaining.append((md_file, matches))

    if remaining:
        print("WARNING: Still have unconverted links:")
        for file, matches in remaining:
            print(f"  {file.name}: {len(matches)} links")
    else:
        print("All links converted successfully!")

if __name__ == "__main__":
    main()
