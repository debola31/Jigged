'use client';

import * as Sentry from "@sentry/nextjs";
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import ListItemIcon from '@mui/material/ListItemIcon';
import Divider from '@mui/material/Divider';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import BusinessIcon from '@mui/icons-material/Business';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  getUserCompanies,
  setLastCompany,
  homePathForRole,
  UserCompanyAccess,
} from '@/utils/companyAccess';

export default function CompanySelector() {
  const router = useRouter();
  const { user } = useAuth();
  const [companies, setCompanies] = useState<UserCompanyAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchCompanies() {
      if (!user) return;

      try {
        const userCompanies = await getUserCompanies(user.id);
        setCompanies(userCompanies);

        // If no companies, redirect to no-access page
        if (userCompanies.length === 0) {
          router.replace('/no-access');
        }
      } catch (err) {
        console.error('Error fetching companies:', err);
        Sentry.captureException(err);
        setError('Failed to load companies. Please try again.');
      } finally {
        setLoading(false);
      }
    }

    fetchCompanies();
  }, [user, router]);

  const handleCompanySelect = async (company: UserCompanyAccess) => {
    if (!user) return;

    const { company_id: companyId, role } = company;

    try {
      await setLastCompany(user.id, companyId);
      // Role-aware, so an operator with more than one company goes straight to the shop
      // floor. This used to push /dashboard unconditionally and rely on AuthGuard to
      // bounce them back out — it worked, but it cost a round trip and a visible flash
      // on one of the two screens that shape a new user's first impression.
      router.push(homePathForRole(role, companyId));
    } catch (err) {
      console.error('Error setting last company:', err);
      Sentry.captureException(err);
      setError('Failed to select company. Please try again.');
    }
  };

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '200px',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="error" sx={{ maxWidth: 500, mx: 'auto', mt: 4 }}>
        {error}
      </Alert>
    );
  }

  return (
    <Card elevation={3} sx={{ maxWidth: 500, mx: 'auto', mt: 8 }}>
      <CardContent sx={{ p: 4 }}>
        <Typography variant="h5" component="h2" gutterBottom align="center">
          Select Company
        </Typography>
        <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 3 }}>
          Choose which company you want to access
        </Typography>

        <List disablePadding>
          {companies.map((company, index) => (
            <Box key={company.company_id}>
              {index > 0 && <Divider />}
              <ListItemButton
                onClick={() => handleCompanySelect(company)}
                sx={{ py: 2 }}
              >
                <ListItemIcon>
                  <BusinessIcon color="primary" />
                </ListItemIcon>
                <ListItemText
                  primary={company.companies.name}
                  secondary={`Role: ${company.role}`}
                  primaryTypographyProps={{ fontWeight: 500 }}
                />
              </ListItemButton>
            </Box>
          ))}
        </List>
      </CardContent>
    </Card>
  );
}
