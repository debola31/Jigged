import { redirect } from 'next/navigation';

/**
 * `/inventory` used to be a second parts list — `getStockedParts`, i.e.
 * `parts WHERE is_stocked`, with three extra columns (quantity, status, unit) and a
 * stock-status filter. It had no unique capability: its toolbar's Import and Delete
 * both existed on `/parts`, and it already delegated part creation to `/parts/new`.
 * Two pages for one item master is why nobody could say what either was for.
 *
 * The columns and the status filter now live on `/parts`, which makes Parts the single
 * item master — and the stock filter there doubles as the shop-wide shortage lens that
 * `JobPartMaterialsCard`'s "N short" chip needs (`?status=low`).
 *
 * Kept as a redirect rather than deleted so existing bookmarks and any link we haven't
 * found don't 404. A plain `redirect` (307) rather than `permanentRedirect`, so nothing
 * gets cached in a browser if this is ever revisited.
 */
export default async function InventoryRedirectPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;
  redirect(`/dashboard/${companyId}/parts`);
}
