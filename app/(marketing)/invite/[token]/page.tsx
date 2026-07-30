import type { Metadata } from 'next';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import { VALID_TOKENS } from '../tokens';
import InviteForm from '@/components/marketing/InviteForm';

interface Props {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  if (!VALID_TOKENS.includes(token)) {
    return { title: 'Invalid Invite \u2014 Jigged' };
  }
  return {
    title: 'Get Started with Jigged',
    description:
      'Sign up for early access to Jigged \u2014 modern shop floor management for precision manufacturers.',
  };
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params;
  const isValid = VALID_TOKENS.includes(token);

  if (!isValid) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 'calc(100vh - 64px - 48px)',
          py: { xs: 6, md: 10 },
        }}
      >
        <Container maxWidth="sm">
          <Box sx={{ textAlign: 'center' }}>
            <Typography
              variant="h4"
              component="h1"
              sx={{ fontWeight: 700, mb: 2 }}
            >
              Invalid Invite Link
            </Typography>
            <Typography
              variant="body1"
              sx={{
                color: 'rgba(255, 255, 255, 0.75)',
                mb: 4,
                lineHeight: 1.7,
              }}
            >
              This invite link isn&apos;t valid. Visit our homepage to learn more
              about Jigged or request early access.
            </Typography>
            {/* `href` alone, NOT `component={Link}`. This page is a Server Component,
                and MUI's Button is a Client Component — so passing the next/link
                function as a prop cannot be serialised across the boundary and threw
                "Functions cannot be passed directly to Client Components" during
                render (Sentry JAVASCRIPT-NEXTJS-1K). MUI renders an <a> whenever href
                is set, so this needs no component override. Losing client-side
                prefetch is the right trade here: it's a single escape hatch out of an
                error page, where a full navigation is if anything more robust. */}
            <Button
              href="/"
              variant="contained"
              size="large"
              sx={{
                minWidth: 200,
                fontWeight: 600,
                background:
                  'linear-gradient(135deg, #D4872A 0%, #4682B4 50%, #2BBCB3 100%)',
                '&:hover': {
                  background:
                    'linear-gradient(135deg, #b8721f 0%, #3A6B94 50%, #239e97 100%)',
                },
              }}
            >
              Go to Homepage
            </Button>
          </Box>
        </Container>
      </Box>
    );
  }

  return <InviteForm />;
}
