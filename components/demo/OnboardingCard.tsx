'use client';

import { useState, useEffect } from 'react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined';
import { useRouter } from 'next/navigation';
import { useDemoMode } from '@/components/providers/DemoModeProvider';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';

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

/** A step row in the first-run "Get started" checklist. */
function Step({
  index,
  icon,
  title,
  description,
  action,
}: {
  index: number;
  icon: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', py: 2 }}>
      <Box
        sx={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {index}
      </Box>
      <Box sx={{ flex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {icon}
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
          {description}
        </Typography>
        {action}
      </Box>
    </Box>
  );
}

export default function OnboardingCard({ companyId, isEmpty }: OnboardingCardProps) {
  const { hasDemoCompany, isDemoMode, enterDemoMode, isCreating, isLoading } = useDemoMode();
  const { features } = useCompanyFeatures();
  const router = useRouter();
  const importEnabled = !!features.data_import;
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

  // First-run onboarding checklist (research: a "Get started" checklist on the home page,
  // not a permanent nav item). Steps are numbered; the import step leads when enabled.
  let stepNumber = 0;

  return (
    <Card elevation={2} sx={{ mb: 3 }}>
      <CardContent sx={{ p: 3 }}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 0.5 }}>
          Get started
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
          A couple of steps to set up your shop in Jigged.
        </Typography>

        {importEnabled && (
          <>
            <Divider />
            <Step
              index={(stepNumber += 1)}
              icon={<UploadFileIcon color="action" fontSize="small" />}
              title="Import your existing data"
              description="Bring your parts, vendors, work centers, routings, and BOMs into Jigged. We'll check everything first and show you exactly what will come in — nothing is saved until you say so."
              action={
                <Button
                  variant="contained"
                  startIcon={<UploadFileIcon />}
                  onClick={() => router.push(`/dashboard/${companyId}/import`)}
                >
                  Import your data
                </Button>
              }
            />
          </>
        )}

        <Divider />
        <Step
          index={(stepNumber += 1)}
          icon={<ScienceOutlinedIcon color="action" fontSize="small" />}
          title="Explore a sample shop"
          description="Not ready to import yet? See how everything works with a populated demo company first."
          action={
            <Button
              variant="outlined"
              onClick={enterDemoMode}
              disabled={isCreating}
              startIcon={isCreating ? <CircularProgress size={16} /> : undefined}
            >
              {isCreating ? 'Setting up demo…' : 'Enter Demo Mode'}
            </Button>
          }
        />

        <Divider sx={{ mb: 1.5 }} />
        <Button variant="text" color="inherit" onClick={handleDismiss}>
          Skip, I&apos;ll start fresh
        </Button>
      </CardContent>
    </Card>
  );
}
