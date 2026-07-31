import { redirect } from 'next/navigation';

/**
 * `/profile` folded into the "Me" tab.
 *
 * Everything this page held — the name/email/company card, Give feedback, and Log out — now
 * lives beneath the operator's own work at `/my-work`, which the bottom bar labels **Me**. See
 * `components/operator/OperatorAccountBlock.tsx` for why the work leads and why Log out sits
 * last.
 *
 * A redirect rather than a deletion: this path is the one an operator may have bookmarked, and
 * it was a bottom tab until this change. The route stays `/my-work` on the other side because
 * renaming routes is churn for no user-visible gain.
 */
export default async function OperatorProfileRedirect({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;
  redirect(`/operator/${companyId}/my-work`);
}
