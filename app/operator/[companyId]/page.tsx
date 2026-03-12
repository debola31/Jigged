import { redirect } from 'next/navigation';

export default async function OperatorRoot({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = await params;
  redirect(`/operator/${companyId}/jobs`);
}
