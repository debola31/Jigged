import Box from '@mui/material/Box';
import MarketingHeader from '@/components/marketing/MarketingHeader';
import MarketingFooter from '@/components/marketing/MarketingFooter';

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <MarketingHeader />
      <Box component="main" sx={{ flex: 1 }}>
        {children}
      </Box>
      <MarketingFooter />
    </Box>
  );
}
