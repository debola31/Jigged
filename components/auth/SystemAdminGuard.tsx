'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import { useAuth } from '@/components/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase';

interface SystemAdminGuardProps {
  children: React.ReactNode;
}

export default function SystemAdminGuard({ children }: SystemAdminGuardProps) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [isSystemAdmin, setIsSystemAdmin] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      router.replace('/login');
      return;
    }

    async function checkSystemAdmin() {
      try {
        const supabase = getSupabase();
        const { data, error } = await supabase.rpc('is_system_admin', {
          check_user_id: user!.id,
        });

        if (error) {
          console.error('Error checking system admin status:', error);
          setIsSystemAdmin(false);
        } else {
          setIsSystemAdmin(data === true);
        }
      } catch (err) {
        console.error('Error checking system admin status:', err);
        setIsSystemAdmin(false);
      } finally {
        setLoading(false);
      }
    }

    checkSystemAdmin();
  }, [user, authLoading, router]);

  if (authLoading || loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (!user) {
    return null;
  }

  if (!isSystemAdmin) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
        }}
      >
        <Card elevation={3} sx={{ maxWidth: 400, textAlign: 'center' }}>
          <CardContent sx={{ p: 4 }}>
            <Typography variant="h6" gutterBottom color="error.main">
              Access Denied
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              You don&apos;t have system admin privileges.
            </Typography>
            <Button
              variant="contained"
              onClick={() => router.push('/select-company')}
            >
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </Box>
    );
  }

  return <>{children}</>;
}
