'use client';

import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { useUserRole } from '@/hooks/useUserRole';

interface AdminGuardProps {
  children: React.ReactNode;
  message?: string;
}

/**
 * Wraps content that should only be visible to owner/admin roles.
 * Shows a permission denied message for other roles.
 */
export default function AdminGuard({
  children,
  message = "You don\u2019t have permission to access this page.",
}: AdminGuardProps) {
  const router = useRouter();
  const params = useParams();
  const companyId = params.companyId as string;
  const { isAdmin, loading } = useUserRole();

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!isAdmin) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '60vh',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <Typography variant="h6" color="text.secondary">
          {message}
        </Typography>
        <Button variant="contained" onClick={() => router.push(`/dashboard/${companyId}`)}>
          Back to Dashboard
        </Button>
      </Box>
    );
  }

  return <>{children}</>;
}
