'use client';

import Box from '@mui/material/Box';
import { CustomerForm } from '@/components/customers';
import { EMPTY_CUSTOMER_FORM } from '@/types/customer';

export default function NewCustomerPage() {
  return (
    <Box>
      <CustomerForm initialData={EMPTY_CUSTOMER_FORM} />
    </Box>
  );
}
