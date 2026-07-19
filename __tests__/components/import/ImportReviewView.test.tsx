import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import ImportReviewView from '@/components/data-import/ImportReviewView';
import type { EntityType, Finding, ImportReview } from '@/types/data-import';
import type { EntityImpact } from '@/lib/dataImportImpact';

function finding(p: Partial<Finding> & Pick<Finding, 'id' | 'category' | 'severity' | 'title'>): Finding {
  return {
    entity_type: 'unknown',
    detail: '',
    count: 0,
    examples: [],
    source_files: [],
    verified: true,
    recommended_action: '',
    ...p,
  };
}

function review(findings: Finding[], files: { filename: string; entity_type: EntityType; row_count: number }[] = []): ImportReview {
  return {
    schema_version: 1,
    erp_detection: {
      source: 'unknown', display_name: 'Unknown', confidence: 0, matched_headers: [],
      evidence: '', alternatives: [], header_signature: '', ai_provider: '', ai_model: '',
    },
    files: files.map((f) => ({ ...f, entity_confidence: 1, headers: [], column_roles: {} })),
    findings,
    summary: '',
    recommendations: [],
    narrative_available: true,
    ai_provider: '',
    ai_model: '',
    generated_at: '',
  };
}

const impact = (lost: number): EntityImpact[] => [
  { entityType: 'parts', label: 'parts', total: 8393, lost },
];

describe('ImportReviewView — the consequence line', () => {
  it('leads with what you lose if you import now', () => {
    render(
      <ImportReviewView
        report={review([finding({ id: 'gap.parts.primary_unit', category: 'data_gap', severity: 'critical', title: 'no unit', count: 7672 })])}
        impact={impact(7672)}
      />,
    );
    expect(screen.getByText(/7,672 parts.*won't come in/i)).toBeInTheDocument();
  });

  it('says everything comes in when nothing is at risk', () => {
    render(<ImportReviewView report={review([])} impact={impact(0)} />);
    expect(screen.getByText(/everything you uploaded will come in/i)).toBeInTheDocument();
  });
});

describe('ImportReviewView — the deletions', () => {
  it('shows no severity count chips (no "N blocking" / "N to review" tallies)', () => {
    render(
      <ImportReviewView
        report={review([
          finding({ id: 'gap.parts.primary_unit', category: 'data_gap', severity: 'critical', title: 'no unit', count: 7672 }),
          finding({ id: 'name_variant.parts.x', category: 'name_variant', severity: 'warning', title: 'look-alikes', count: 13 }),
        ])}
        impact={impact(7672)}
      />,
    );
    // A count summary would render text like "1 blocking" / "1 to review".
    expect(screen.queryByText(/\d+\s+(blocking|to review|to look at|info)/i)).toBeNull();
  });

  it('does not render a record-count / "what you\'re importing" outlook panel', () => {
    render(
      <ImportReviewView
        report={review([], [{ filename: 'parts.csv', entity_type: 'parts', row_count: 8393 }])}
        impact={impact(0)}
      />,
    );
    expect(screen.queryByText(/what you're importing/i)).toBeNull();
  });
});

describe('ImportReviewView — tasks', () => {
  it('a blocking task carries no "Optional" tag; a non-blocking one does', () => {
    render(
      <ImportReviewView
        report={review([
          finding({ id: 'gap.parts.primary_unit', category: 'data_gap', severity: 'critical', title: 'Give parts a unit', count: 7672, source_files: ['parts.csv'] }),
          finding({ id: 'name_variant.parts.x', category: 'name_variant', severity: 'warning', title: 'Check look-alike names', count: 13, source_files: ['parts.csv'] }),
        ])}
        impact={impact(7672)}
      />,
    );
    expect(screen.getByText('Give parts a unit')).toBeInTheDocument();
    // Exactly one "Optional" tag, on the warning task.
    expect(screen.getAllByText('Optional')).toHaveLength(1);
  });

  it('opens a task by clicking its row — the row is the affordance', async () => {
    const onOpenTask = vi.fn();
    render(
      <ImportReviewView
        report={review([
          finding({ id: 'gap.parts.primary_unit', category: 'data_gap', severity: 'critical', title: 'Give parts a unit', count: 7672, source_files: ['parts.csv'] }),
        ])}
        impact={impact(7672)}
        onOpenTask={onOpenTask}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /give parts a unit/i }));
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'gap.parts.primary_unit' }));
  });

  it('tucks info findings behind "other things we noticed", not in the task list', async () => {
    render(
      <ImportReviewView
        report={review([
          finding({ id: 'gap.parts.primary_unit', category: 'data_gap', severity: 'critical', title: 'Give parts a unit', count: 4, source_files: ['parts.csv'] }),
          finding({ id: 'inactive.parts.csv', category: 'inactive_flag', severity: 'info', title: '41 parts are inactive', count: 41 }),
        ])}
        impact={impact(4)}
      />,
    );
    const tasks = screen.getByText('What to sort out').closest('div')!;
    expect(within(tasks).queryByText('41 parts are inactive')).toBeNull();
    // It's disclosed only under the collapsed "noticed" section.
    await userEvent.click(screen.getByRole('button', { name: /other thing.*we noticed/i }));
    expect(screen.getByText('41 parts are inactive')).toBeInTheDocument();
  });
});
