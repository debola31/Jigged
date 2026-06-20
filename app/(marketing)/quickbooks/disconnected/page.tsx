import type { Metadata } from 'next';
import Container from '@mui/material/Container';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';

export const metadata: Metadata = {
  title: 'QuickBooks Disconnected – Jigged',
  description: 'Your QuickBooks Online company has been disconnected from Jigged.',
};

// Intuit "Disconnect URL": where a user lands after disconnecting Jigged from
// inside QuickBooks. Informational only — the access/refresh tokens are
// invalidated by Intuit on disconnect, and Jigged marks the connection
// reconnect-required on its next call (invalid_grant).
export default function QuickBooksDisconnectedPage() {
  return (
    <Container maxWidth="sm" sx={{ py: { xs: 8, md: 12 } }}>
      <Stack spacing={3} alignItems="flex-start">
        <Typography variant="h3" component="h1" sx={{ fontWeight: 700 }}>
          QuickBooks disconnected
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Your QuickBooks Online company has been disconnected from Jigged. Jigged will no
          longer send invoices to QuickBooks. Any invoices already created in QuickBooks are
          unaffected.
        </Typography>
        <Typography variant="body1" color="text.secondary">
          To reconnect, sign in to Jigged and open <strong>Settings → QuickBooks</strong>, then
          choose <strong>Connect</strong>.
        </Typography>
        <Button href="/login" variant="contained" size="large">
          Sign in to Jigged
        </Button>
      </Stack>
    </Container>
  );
}
