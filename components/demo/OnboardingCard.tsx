'use client';

import { useState, useEffect } from 'react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { useDemoMode } from '@/components/providers/DemoModeProvider';

const DISMISSED_KEY = 'jigged_onboarding_dismissed';

function isDismissed(companyId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const dismissed = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}');
    return !!dismissed[companyId];
  } catch {
    return false;
  }
}

function setDismissed(companyId: string) {
  try {
    const dismissed = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}');
    dismissed[companyId] = true;
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
  } catch {
    // localStorage unavailable
  }
}

interface OnboardingCardProps {
  companyId: string;
  isEmpty: boolean;
}

export default function OnboardingCard({ companyId, isEmpty }: OnboardingCardProps) {
  const { hasDemoCompany, isDemoMode, enterDemoMode, isCreating, isLoading } = useDemoMode();
  const [dismissed, setDismissedState] = useState(true);

  useEffect(() => {
    setDismissedState(isDismissed(companyId));
  }, [companyId]);

  // Don't show if: loading, already in demo, has a demo company, has data, or dismissed
  if (isLoading || isDemoMode || hasDemoCompany || !isEmpty || dismissed) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(companyId);
    setDismissedState(true);
  };

  return (
    <Card elevation={2} sx={{ mb: 3 }}>
      <CardContent sx={{ p: 3 }}>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
          Welcome to Jigged!
        </Typography>
        <Typography variant="body1" sx={{ color: 'text.secondary', mb: 3 }}>
          Want to see what a populated shop looks like? Enter demo mode to
          explore sample customers, parts, quotes, jobs, and more.
        </Typography>
        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button
            variant="contained"
            onClick={enterDemoMode}
            disabled={isCreating}
            startIcon={isCreating ? <CircularProgress size={16} /> : undefined}
          >
            {isCreating ? 'Setting up demo…' : 'Enter Demo Mode'}
          </Button>
          <Button variant="text" color="inherit" onClick={handleDismiss}>
            Skip, I&apos;ll start fresh
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
}
