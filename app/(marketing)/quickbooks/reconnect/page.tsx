import type { Metadata } from 'next';
import Container from '@mui/material/Container';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';

export const metadata: Metadata = {
  title: 'Reconnect QuickBooks – Jigged',
  description: 'Reconnect your QuickBooks Online company to Jigged.',
};

// Intuit "Reconnect URL" (mandatory since 2026): a page from which customers can
// reconnect. Reconnecting happens per company inside Jigged, so this directs the
// user to sign in and open Settings → QuickBooks.
export default function QuickBooksReconnectPage() {
  return (
    <Container maxWidth="sm" sx={{ py: { xs: 8, md: 12 } }}>
      <Stack spacing={3} alignItems="flex-start">
        <Typography variant="h3" component="h1" sx={{ fontWeight: 700 }}>
          Reconnect QuickBooks
        </Typography>
        <Typography variant="body1" color="text.secondary">
          To reconnect QuickBooks Online to Jigged, sign in and open{' '}
          <strong>Settings → QuickBooks</strong>, then choose <strong>Connect</strong>. You&apos;ll
          be returned to Jigged after authorizing with Intuit.
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Reconnecting only re-establishes the link between Jigged and your QuickBooks company —
          your existing QuickBooks data is never changed.
        </Typography>
        <Button href="/login" variant="contained" size="large">
          Sign in to Jigged
        </Button>
      </Stack>
    </Container>
  );
}
