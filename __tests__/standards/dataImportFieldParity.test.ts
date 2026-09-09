import { describe, it, expect } from 'vitest';
import {
  ANALYZER_VALUE_ROLES,
  REPO_ROOT,
  SCHEMA_SOURCES,
  findParityViolations,
  formatViolations,
  parsePythonSchema,
} from '../../scripts/dataImportFieldParityCheck';
import { ENTITY_FIELDS } from '../../lib/dataImportSchema';

const SAMPLE = `
OTHER = 1

PART_SCHEMA = {
    "part_name": {
        "type": "string",
        "required": True,
        "description": "Part name identifier (unique per company)",
    },
    "primary_unit": {
        "type": "string",
        # A comment mentioning "required": True should not count for a sibling.
        "required": True,
        "description": "Primary unit of measure",
    },
    "reorder_point": {
        "type": "number",
        "required": False,
        "description": "Reorder point",
    },
}

TRAILING = 2
`;

describe('parsePythonSchema', () => {
  it('reads every key and its required flag', () => {
    const parsed = parsePythonSchema(SAMPLE, 'PART_SCHEMA');
    expect(Object.keys(parsed)).toEqual(['part_name', 'primary_unit', 'reorder_point']);
    expect(parsed.part_name.required).toBe(true);
    expect(parsed.reorder_point.required).toBe(false);
  });

  it('stops at the dict it was asked for', () => {
    expect(parsePythonSchema(SAMPLE, 'PART_SCHEMA')).not.toHaveProperty('TRAILING');
  });

  it('survives a multi-line, concatenated description', () => {
    const src = `
VENDOR_SCHEMA = {
    "primary_contact_role": {
        "type": "string",
        "required": False,
        "description": (
            "Role of the primary contact. One of: "
            + ", ".join(VALUES)
            + ". Defaults to 'sales'."
        ),
    },
    "city": {
        "type": "string",
        "required": False,
        "description": "City name",
    },
}
`;
    expect(Object.keys(parsePythonSchema(src, 'VENDOR_SCHEMA'))).toEqual([
      'primary_contact_role',
      'city',
    ]);
  });

  // A guard that silently parses nothing passes every rule it has. Both of these used to be
  // the realistic way this check could rot: a constant renamed, or a file reorganised.
  it('throws rather than returning empty when the constant is missing', () => {
    expect(() => parsePythonSchema(SAMPLE, 'NOPE_SCHEMA')).toThrow(/NOPE_SCHEMA not found/);
  });

  it('throws when the dict parses to nothing — e.g. reformatted out of the expected shape', () => {
    const reindented = `
WORK_CENTER_SCHEMA = {
  "name": {"type": "string", "required": True},
}
`;
    expect(() => parsePythonSchema(reindented, 'WORK_CENTER_SCHEMA')).toThrow(
      /parsed to zero fields/,
    );
  });
});

describe('import field-catalog parity', () => {
  it('has no violations across the repo', () => {
    const violations = findParityViolations(REPO_ROOT);
    expect(violations.length, `\n${formatViolations(violations)}\n`).toBe(0);
  });

  it('covers every entity the Map step can classify a file as', () => {
    // ENTITY_FIELDS is the catalog; a new entity added there with no schema source would
    // otherwise be checked against nothing at all.
    for (const entity of Object.keys(ENTITY_FIELDS)) {
      expect(SCHEMA_SOURCES, `no Python schema registered for '${entity}'`).toHaveProperty(entity);
    }
  });

  it("still names routings.sequence, the role whose absence #777 was found through", () => {
    expect(ANALYZER_VALUE_ROLES.routings).toContain('sequence');
    expect(ENTITY_FIELDS.routings?.map((f) => f.key)).toContain('sequence');
  });
});
