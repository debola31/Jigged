import Box from '@mui/material/Box';
import { Space_Grotesk } from 'next/font/google';
import MarketingHeader from '@/components/marketing/MarketingHeader';
import MarketingFooter from '@/components/marketing/MarketingFooter';

// Editorial display face — a designed grotesque used only on the marketing page,
// exposed as a CSS variable so section components can opt into it for headlines.
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-space-grotesk',
  display: 'swap',
});

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Box
      className={spaceGrotesk.variable}
      sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}
    >
      <MarketingHeader />
      <Box component="main" sx={{ flex: 1 }}>
        {children}
      </Box>
      <MarketingFooter />
    </Box>
  );
}
