'use client';

import InlineNameEditor from '@/components/common/InlineNameEditor';
import type { SaveState } from '@/components/common/SaveStatus';
import type { CustomerFieldEditingProps } from '@/components/customers/customerFieldEditing';

/**
 * The customer's name in the detail-page header.
 *
 * A thin binding over {@link InlineNameEditor}, which owns the behaviour and is
 * shared with the vendor header. It used to own that behaviour itself, and the
 * duplicate would have carried the wrapping bug into the second copy — the
 * editor rendered at heading size on ONE line, so a long name scrolled to the
 * caret and hid its own beginning.
 *
 * Uniqueness is checked by the page before the write, including the case where
 * the check itself fails (refused, not reported as a duplicate).
 */
export default function CustomerIdentityFields({
  fieldErrors,
  onTextChange,
  readOnly,
  saveState,
  displayName,
  onCancelEdit,
  onCommitName,
}: CustomerFieldEditingProps & {
  saveState: SaveState;
  /** The last SAVED name, so cancelling can restore it. */
  displayName: string;
  onCancelEdit: () => void;
  /** Persists the name and reports whether it saved, so a refused rename keeps
   *  the editor open with its error rather than closing and losing both. */
  onCommitName: (name: string) => Promise<boolean>;
}) {
  return (
    <InlineNameEditor
      displayName={displayName}
      label="Company name"
      editTooltip="Rename this customer"
      error={fieldErrors.name}
      saveState={saveState}
      readOnly={readOnly}
      onChange={(v) => onTextChange('name', v)}
      onCommit={onCommitName}
      onCancel={onCancelEdit}
    />
  );
}
