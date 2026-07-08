'use client';

import * as Sentry from "@sentry/nextjs";
import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import { Sidebar, Header } from '@/components/layout';
import AppAmbientBackdrop from '@/components/layout/AppAmbientBackdrop';
import { PageTitleProvider } from '@/components/layout/PageTitleProvider';
import { AuthGuard } from '@/components/auth';
import DemoModeProvider from '@/components/providers/DemoModeProvider';
import DemoModeBanner from '@/components/demo/DemoModeBanner';
import { useMobileDrawer } from '@/hooks/useMobileDrawer';
import FeedbackFab, { useFeedbackDialog } from '@/components/feedback/FeedbackFab';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const companyId = params.companyId as string;
  const { isMobile, drawerOpen, openDrawer, closeDrawer } = useMobileDrawer();
  const feedback = useFeedbackDialog();

  // Tag all Sentry events with the current company for multi-tenant context
  useEffect(() => {
    Sentry.setTag("company_id", companyId);
  }, [companyId]);

  return (
    <AuthGuard companyId={companyId} requireCompany>
      <DemoModeProvider>
        <PageTitleProvider>
        <Box sx={{ position: 'relative', minHeight: '100vh' }}>
          {/* Ambient shop-floor backdrop — sits behind the workspace, above the theme base */}
          <AppAmbientBackdrop />
          <Box sx={{ position: 'relative', zIndex: 1, display: 'flex', minHeight: '100vh' }}>
            <Sidebar isMobile={isMobile} open={drawerOpen} onClose={closeDrawer} onFeedbackClick={feedback.openDialog} />
            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', ml: { xs: 0, md: '240px' }, minWidth: 0 }}>
              <Header isMobile={isMobile} onMenuClick={openDrawer} />
              <DemoModeBanner />
              <Box component="main" sx={{ flex: 1, p: { xs: 2, md: 3 }, overflow: 'auto' }}>
                {children}
              </Box>
            </Box>
          </Box>
        </Box>
        <FeedbackFab
          dialogOpen={feedback.dialogOpen}
          snackbarOpen={feedback.snackbarOpen}
          onOpen={feedback.openDialog}
          onClose={feedback.closeDialog}
          onSuccess={feedback.showSuccess}
          onSnackbarClose={feedback.closeSnackbar}
        />
        </PageTitleProvider>
      </DemoModeProvider>
    </AuthGuard>
  );
}
