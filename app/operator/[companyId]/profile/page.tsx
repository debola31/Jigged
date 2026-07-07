'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import LogoutIcon from '@mui/icons-material/Logout';
import FeedbackIcon from '@mui/icons-material/Feedback';
import FeedbackDialog from '@/components/feedback/FeedbackDialog';
import { getCurrentOperator } from '@/utils/operatorAccess';
import { getCompany } from '@/utils/companyAccess';
import { getSupabase } from '@/lib/supabase';
import { clearStoredStation } from '@/components/operator/OperatorStationContext';

/**
 * Operator Profile Page.
 *
 * Shows operator info, current station, work session history,
 * change password link, and logout button.
 */
export default function OperatorProfilePage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.companyId as string;
  const [operatorName, setOperatorName] = useState<string>('');
  const [operatorEmail, setOperatorEmail] = useState<string>('');
  const [operatorUserId, setOperatorUserId] = useState<string>('');
  const [companyName, setCompanyName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState(false);

  useEffect(() => {
    async function loadProfile() {
      setLoading(true);
      setError(null);

      try {
        const supabase = getSupabase();

        // Get auth session for email
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.user) {
          setOperatorEmail(session.user.email || '');
          setOperatorUserId(session.user.id);
        }

        // Get operator info
        const operator = await getCurrentOperator(companyId);
        if (!operator) {
          setError('Operator not found');
          setLoading(false);
          return;
        }

        setOperatorName(operator.name || 'Operator');

        // Fetch company name for branding
        const company = await getCompany(companyId);
        if (company?.name) {
          setCompanyName(company.name);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, [companyId]);

  const handleLogout = async () => {
    // Clears the persisted station (localStorage) on explicit logout — same store
    // OperatorStationContext uses; sessionStorage is no longer the station's home.
    clearStoredStation();
    const supabase = getSupabase();
    await supabase.auth.signOut();
    router.push(`/operator/${companyId}/login`);
  };

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '50vh',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h5" component="h1" fontWeight={600} sx={{ mb: 3 }}>
        Profile
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Operator Info Card */}
      <Card
        elevation={2}
        sx={{
          mb: 3,
          bgcolor: 'rgba(26, 31, 74, 0.55)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <CardContent>
          <Typography variant="h6" fontWeight={600} sx={{ mb: 1 }}>
            {operatorName}
          </Typography>
          {operatorEmail && (
            <Typography variant="body2" color="text.secondary">
              {operatorEmail}
            </Typography>
          )}
          {companyName && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {companyName}
            </Typography>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <Button
          variant="outlined"
          color="error"
          startIcon={<LogoutIcon />}
          onClick={handleLogout}
          fullWidth
          sx={{ minHeight: 48 }}
        >
          Logout
        </Button>
      </Box>
      <Button
        variant="outlined"
        startIcon={<FeedbackIcon />}
        onClick={() => setFeedbackOpen(true)}
        sx={{ mb: 3, minHeight: 48 }}
        fullWidth
      >
        Give Feedback
      </Button>

      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        onSuccess={() => {
          setFeedbackOpen(false);
          setFeedbackSuccess(true);
        }}
        userId={operatorUserId}
      />
      <Snackbar
        open={feedbackSuccess}
        autoHideDuration={4000}
        onClose={() => setFeedbackSuccess(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" onClose={() => setFeedbackSuccess(false)}>
          Thanks for your feedback!
        </Alert>
      </Snackbar>
    </Box>
  );
}
