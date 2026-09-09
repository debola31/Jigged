import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import ColumnMappingStep from '@/components/data-import/ColumnMappingStep';
import { ENTITY_FIELDS } from '@/lib/dataImportSchema';
import type { WorkingFile } from '@/lib/dataImportEditing';
import type { EntityType } from '@/types/data-import';

function file(p: Partial<WorkingFile> & { entityType: EntityType }): WorkingFile {
  return {
    filename: 'customers.csv',
    entityConfidence: 1,
    columnRoles: {},
    headers: [],
    rows: [],
    ...p,
  } as WorkingFile;
}

/** A customers file the AI mapped confidently: name + terms + an email it got right. */
const mappedCustomers = file({
  entityType: 'customers',
  headers: ['CustName', 'Terms Code', 'Email', 'City'],
  columnRoles: { name: 'CustName', default_payment_terms: 'Terms Code', contact_email: 'Email' },
  rows: [{ CustName: 'Acme Tool', 'Terms Code': 'Net 30', Email: 'a@acme.test', City: 'Dayton' }],
});

const noop = { onEntityChange: vi.fn(), onRoleChange: vi.fn() };

/** A required field renders as `{label} *` inside one <p>, so match the row by its own text
 *  content with the asterisk stripped rather than by an exact string. */
const fieldRow = (label: string) =>
  screen.queryAllByText(
    (_content, el) => el?.tagName === 'P' && el.textContent?.replace(/\s*\*$/, '') === label,
  );

const openDetails = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: /see how we matched each column/i }));

describe('ColumnMappingStep — the default card', () => {
  // The widening (#777) added 9 optional customer fields. The card only asks about REQUIRED
  // ones, so the surface an owner meets first must be exactly as quiet as it was before.
  it('asks nothing when every required field is mapped', () => {
    render(<ColumnMappingStep files={[mappedCustomers]} {...noop} />);

    expect(screen.getByText(/we matched everything we need/i)).toBeInTheDocument();
    expect(screen.queryByText(/which column has the/i)).not.toBeInTheDocument();
  });

  it('asks once per missing required field, and only those', () => {
    render(
      <ColumnMappingStep
        files={[file({ ...mappedCustomers, columnRoles: {} })]}
        {...noop}
      />,
    );

    // `name` is the only required customer field; the other ten must not be asked about.
    const questions = screen.getAllByText(/which column has the/i);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toHaveTextContent(/customer name/i);
  });
});

describe('ColumnMappingStep — the details panel', () => {
  it('offers every catalog field, so a mis-mapped one can be corrected', async () => {
    const user = userEvent.setup();
    render(<ColumnMappingStep files={[mappedCustomers]} {...noop} />);
    await openDetails(user);

    // This is the #777 regression test: before the widening only 2 of these rendered, so a
    // wrongly-mapped contact_email or postal_code had no correction surface anywhere.
    expect(ENTITY_FIELDS.customers).toHaveLength(11);
    for (const field of ENTITY_FIELDS.customers ?? []) {
      expect(fieldRow(field.label), field.key).toHaveLength(1);
    }
  });

  it('pre-selects what the AI already matched', async () => {
    const user = userEvent.setup();
    render(<ColumnMappingStep files={[mappedCustomers]} {...noop} />);
    await openDetails(user);

    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('reports a correction against the canonical role, not the label', async () => {
    const onRoleChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ColumnMappingStep files={[mappedCustomers]} onEntityChange={vi.fn()} onRoleChange={onRoleChange} />,
    );
    await openDetails(user);

    await user.click(screen.getByText('Email'));
    await user.click(within(screen.getByRole('listbox')).getByText('City'));

    expect(onRoleChange).toHaveBeenCalledWith(0, 'contact_email', 'City');
  });
});

describe('ColumnMappingStep — grouping', () => {
  it('puts the long contact/address block under a subheading', async () => {
    const user = userEvent.setup();
    render(<ColumnMappingStep files={[mappedCustomers]} {...noop} />);
    await openDetails(user);

    expect(screen.getByText('Contact & address')).toBeInTheDocument();
  });

  it('renders no subheading for an entity whose fields are all ungrouped', async () => {
    const user = userEvent.setup();
    render(
      <ColumnMappingStep
        files={[
          file({
            filename: 'work-centers.csv',
            entityType: 'work_centers',
            headers: ['Machine', 'Rate'],
            columnRoles: { name: 'Machine', labor_rate: 'Rate' },
            rows: [{ Machine: 'HURCO Mill', Rate: '135' }],
          }),
        ]}
        {...noop}
      />,
    );
    await openDetails(user);

    expect(fieldRow('Hourly rate')).toHaveLength(1);
    expect(screen.queryByText('Contact & address')).not.toBeInTheDocument();
    expect(screen.queryByText('Times & rates')).not.toBeInTheDocument();
  });

  it('groups the cost-bearing routing columns, and keeps step number out of the group', async () => {
    const user = userEvent.setup();
    render(
      <ColumnMappingStep
        files={[
          file({
            filename: 'routings.csv',
            entityType: 'routings',
            headers: ['PartNo', 'Op#', 'WC', 'Setup', 'Run'],
            columnRoles: { part_name: 'PartNo', sequence: 'Op#', work_center_name: 'WC' },
            rows: [{ PartNo: 'A-1', 'Op#': '10', WC: 'Mill', Setup: '30', Run: '2.5' }],
          }),
        ]}
        {...noop}
      />,
    );
    await openDetails(user);

    // `sequence` is what the analyzer's sequence_inferred notice tells the owner to map here.
    expect(fieldRow('Step number')).toHaveLength(1);
    expect(screen.getByText('Times & rates')).toBeInTheDocument();
    expect(fieldRow('Setup time (minutes)')).toHaveLength(1);
  });
});
