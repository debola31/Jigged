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
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import Chip from '@mui/material/Chip';
import Snackbar from '@mui/material/Snackbar';
import LockIcon from '@mui/icons-material/Lock';
import LogoutIcon from '@mui/icons-material/Logout';
import FeedbackIcon from '@mui/icons-material/Feedback';
import FeedbackDialog from '@/components/feedback/FeedbackDialog';
import {
  getCurrentOperator,
  getOperatorSessions,
} from '@/utils/operatorAccess';
import { getCompany } from '@/utils/companyAccess';
import { formatDuration } from '@/types/operator';
import type { OperatorSession } from '@/types/operator';
import { getSupabase } from '@/lib/supabase';

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
  const [sessions, setSessions] = useState<OperatorSession[]>([]);
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

        // Load session history
        const sessionData = await getOperatorSessions(operator.id, 50);
        setSessions(sessionData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, [companyId]);

  const handleLogout = async () => {
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('jigged_operator_station');
    }
    const supabase = getSupabase();
    await supabase.auth.signOut();
    router.push(`/operator/${companyId}/login`);
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
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
          startIcon={<LockIcon />}
          onClick={() => router.push(`/operator/${companyId}/change-password`)}
          sx={{ flex: 1, minHeight: 48, minWidth: 140 }}
        >
          Change Password
        </Button>
        <Button
          variant="outlined"
          color="error"
          startIcon={<LogoutIcon />}
          onClick={handleLogout}
          sx={{ flex: 1, minHeight: 48, minWidth: 140 }}
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

      {/* Work History */}
      <Typography variant="h6" fontWeight={600} sx={{ mb: 2 }}>
        Work History
      </Typography>

      {sessions.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <Typography variant="body2" color="text.secondary">
            No work sessions yet.
          </Typography>
        </Box>
      ) : (
        <Card
          elevation={2}
          sx={{
            bgcolor: 'rgba(26, 31, 74, 0.55)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <List disablePadding>
            {sessions.map((session, index) => (
              <Box key={session.id}>
                {index > 0 && <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />}
                <ListItem
                  sx={{ py: 2 }}
                  secondaryAction={
                    <Chip
                      label={session.ended_at ? 'Done' : 'Active'}
                      size="small"
                      color={session.ended_at ? 'default' : 'primary'}
                    />
                  }
                >
                  <ListItemText
                    primary={
                      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                        <Typography variant="body1" fontWeight={600}>
                          {session.job_number || 'Job'}
                        </Typography>
                        {session.operation_name && (
                          <Typography variant="body2" color="text.secondary">
                            - {session.operation_name}
                          </Typography>
                        )}
                      </Box>
                    }
                    secondary={
                      <Box sx={{ mt: 0.5 }}>
                        <Typography variant="caption" color="text.secondary" component="span">
                          {formatDate(session.started_at)} at {formatTime(session.started_at)}
                        </Typography>
                        {session.duration_seconds != null && (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            component="span"
                            sx={{ ml: 2, fontFamily: 'monospace' }}
                          >
                            {formatDuration(session.duration_seconds)}
                          </Typography>
                        )}
                      </Box>
                    }
                  />
                </ListItem>
              </Box>
            ))}
          </List>
        </Card>
      )}
    </Box>
  );
}
