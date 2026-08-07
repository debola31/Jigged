'use client';

import Box from '@mui/material/Box';
import { CustomerForm } from '@/components/customers';
import { EMPTY_CUSTOMER_FORM } from '@/types/customer';
import SubscriptionRequiredNotice from '@/components/billing/SubscriptionRequiredNotice';

export default function NewCustomerPage() {
  return (
    <Box>
      <SubscriptionRequiredNotice entityPlural="customers" />
      <CustomerForm initialData={EMPTY_CUSTOMER_FORM} />
    </Box>
  );
}
