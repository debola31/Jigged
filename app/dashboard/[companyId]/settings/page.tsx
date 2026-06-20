'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import CircularProgress from '@mui/material/CircularProgress';
import { useDemoMode } from '@/components/providers/DemoModeProvider';
import AdminGuard from '@/components/auth/AdminGuard';
import CompanyProfileCard from '@/components/settings/CompanyProfileCard';
import CompanyShippingSettingsCard from '@/components/settings/CompanyShippingSettingsCard';
import QuickBooksIntegrationCard from '@/components/settings/QuickBooksIntegrationCard';

export default function SettingsPage() {
  const params = useParams();
  const companyId = params.companyId as string;
  const {
    isDemoMode,
    hasDemoCompany,
    enterDemoMode,
    exitDemoMode,
    resetDemo,
    isCreating,
    isResetting,
    isLoading,
  } = useDemoMode();
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  const handleReset = async () => {
    setResetDialogOpen(false);
    await resetDemo();
  };

  return (
    <AdminGuard message="You don't have permission to access settings.">
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Shop contact info (header on printed quotes) */}
      <CompanyProfileCard companyId={companyId} />

      {/* Packing-slip number format + default CoC text */}
      <CompanyShippingSettingsCard companyId={companyId} />

      {/* QuickBooks Online connection + invoice push settings */}
      <QuickBooksIntegrationCard companyId={companyId} />

      {/* Demo Mode Section */}
      <Card elevation={2}>
        <CardContent sx={{ p: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Demo Mode
            </Typography>
            {!isLoading && (
              <Chip
                label={isDemoMode ? 'Active' : hasDemoCompany ? 'Available' : 'Not set up'}
                size="small"
                color={isDemoMode ? 'warning' : 'default'}
                variant={isDemoMode ? 'filled' : 'outlined'}
              />
            )}
          </Box>

          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
            Demo mode lets you explore Jigged with pre-populated sample data —
            customers, parts, quotes, jobs, and more. Your real company data is
            never affected.
          </Typography>

          <Divider sx={{ mb: 3 }} />

          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {isDemoMode ? (
              <Button variant="contained" onClick={exitDemoMode}>
                Back to My Company
              </Button>
            ) : (
              <Button
                variant="contained"
                onClick={enterDemoMode}
                disabled={isCreating || isLoading}
                startIcon={isCreating ? <CircularProgress size={16} /> : undefined}
              >
                {isCreating
                  ? 'Setting up demo…'
                  : hasDemoCompany
                    ? 'Enter Demo Mode'
                    : 'Set Up Demo Mode'}
              </Button>
            )}

            {hasDemoCompany && (
              <Button
                variant="outlined"
                color="error"
                onClick={() => setResetDialogOpen(true)}
                disabled={isResetting}
                startIcon={isResetting ? <CircularProgress size={16} /> : undefined}
              >
                {isResetting ? 'Resetting…' : 'Reset Demo'}
              </Button>
            )}
          </Box>
        </CardContent>
      </Card>

      {/* Reset Confirmation Dialog */}
      <Dialog open={resetDialogOpen} onClose={() => setResetDialogOpen(false)}>
        <DialogTitle>Reset Demo?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This will restore the demo to its original state. Any changes you
            made in demo mode will be lost.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResetDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleReset} color="error" variant="contained">
            Reset Demo
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
    </AdminGuard>
  );
}
