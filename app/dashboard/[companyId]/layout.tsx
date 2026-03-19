'use client';

import * as Sentry from "@sentry/nextjs";
import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import { Sidebar, Header } from '@/components/layout';
import { AuthGuard } from '@/components/auth';
import DemoModeProvider from '@/components/providers/DemoModeProvider';
import DemoModeBanner from '@/components/demo/DemoModeBanner';
import { useMobileDrawer } from '@/hooks/useMobileDrawer';
import FeedbackFab from '@/components/feedback/FeedbackFab';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const companyId = params.companyId as string;
  const { isMobile, drawerOpen, openDrawer, closeDrawer } = useMobileDrawer();

  // Tag all Sentry events with the current company for multi-tenant context
  useEffect(() => {
    Sentry.setTag("company_id", companyId);
  }, [companyId]);

  return (
    <AuthGuard companyId={companyId} requireCompany>
      <DemoModeProvider>
        <Box sx={{ display: 'flex', minHeight: '100vh' }}>
          <Sidebar isMobile={isMobile} open={drawerOpen} onClose={closeDrawer} />
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', ml: { xs: 0, md: '240px' }, minWidth: 0 }}>
            <Header isMobile={isMobile} onMenuClick={openDrawer} />
            <DemoModeBanner />
            <Box component="main" sx={{ flex: 1, p: { xs: 2, md: 3 }, overflow: 'auto' }}>
              {children}
            </Box>
          </Box>
        </Box>
        <FeedbackFab />
      </DemoModeProvider>
    </AuthGuard>
  );
}
