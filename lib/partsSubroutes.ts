/**
 * Every named page under `/dashboard/{companyId}/parts/…`.
 *
 * The slot after `parts` is either one of these or a part ID, and the code that
 * reads it cannot tell the difference by looking. So a page added without a line
 * here does not fail — it silently titles itself "Part Details", which is exactly
 * how `/parts/drawings` shipped calling itself that in the header and in the
 * feedback dialog at the same time.
 *
 * Both readers import THIS. Two copies of the list is the same bug with two places
 * to forget.
 */
export const PARTS_SUBROUTES: Record<string, string> = {
  new: 'New Part',
  edit: 'Edit Part',
  import: 'Import Parts',
  drawings: 'Add parts from drawings',
  bom: 'Bill of Materials',
};
