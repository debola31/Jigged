'use client';

import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import LogoutIcon from '@mui/icons-material/Logout';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import { SystemAdminGuard } from '@/components/auth';
import { useAuth } from '@/components/providers/AuthProvider';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { signOut } = useAuth();

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  return (
    <SystemAdminGuard>
      <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <AppBar
          position="sticky"
          elevation={4}
          sx={{
            bgcolor: 'rgba(17, 20, 57, 0.95)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <Toolbar>
            <AdminPanelSettingsIcon sx={{ mr: 1.5, color: 'primary.main' }} />
            <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 600 }}>
              System Admin
            </Typography>
            <Button
              onClick={handleSignOut}
              startIcon={<LogoutIcon />}
              sx={{
                color: 'rgba(255, 255, 255, 0.7)',
                textTransform: 'none',
                '&:hover': {
                  bgcolor: 'rgba(239, 68, 68, 0.1)',
                  color: 'error.main',
                },
              }}
            >
              Sign Out
            </Button>
          </Toolbar>
        </AppBar>
        <Box
          component="main"
          sx={{
            flex: 1,
            p: 3,
            maxWidth: 1200,
            mx: 'auto',
            width: '100%',
          }}
        >
          {children}
        </Box>
      </Box>
    </SystemAdminGuard>
  );
}
