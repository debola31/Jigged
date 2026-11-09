'use client';

import { useState } from 'react';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import posthog from 'posthog-js';
import * as Sentry from '@sentry/nextjs';

import SettingsSection from '@/components/settings/SettingsSection';
import SaveStatus, { type SaveState } from '@/components/common/SaveStatus';
import LoadFailedState from '@/components/common/LoadFailedState';
import { useLoad } from '@/hooks/useLoad';
import { readCompanyFeatures } from '@/lib/featureFlags';
import { toError } from '@/lib/supabaseErrors';
import { setAssistantAccess } from '@/utils/aiAssistantAccess';
import { getCompany } from '@/utils/companyAccess';

interface Access {
  enabled: boolean;
  writes: boolean;
}

/**
 * What any AI assistant may do in this company: nothing, read only, or read and change. Two
 * opt-out flags (`ai_assistants`, `ai_assistant_writes`), on by default, enforced by the /mcp tool
 * wrapper. Each switch auto-saves on change (docs/interaction-standards.md §2: a single,
 * independently valid, non-financial value).
 *
 * Rendered on the real company only. The wrapper reads these from the real company even when an
 * assistant works in the demo, so a switch shown in demo mode would change nothing.
 */
export default function AiAssistantsCard({ companyId }: { companyId: string }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  const { data, loading, error, reload } = useLoad(
    async () => {
      const company = await getCompany(companyId);
      const features = readCompanyFeatures(company);
      return { enabled: features.ai_assistants, writes: features.ai_assistant_writes };
    },
    [companyId],
  );

  const current = access ?? data;

  const save = async (next: Access) => {
    const previous = current;
    setAccess(next);
    setSaveState('saving');
    try {
      await setAssistantAccess(companyId, { ai_assistants: next.enabled, ai_assistant_writes: next.writes });
      setSaveState('saved');
      posthog.capture('ai assistant access changed', {
        ai_assistants: next.enabled,
        ai_assistant_writes: next.writes,
      });
    } catch (err) {
      Sentry.captureException(toError(err));
      setAccess(previous);
      setSaveState('error');
    }
  };

  return (
    <SettingsSection
      title="AI Assistants"
      statusChip={<SaveStatus state={saveState} />}
      description="Let office users work in Jigged from their own ChatGPT or Claude. Operators can never connect an assistant."
    >
      {loading && !current ? null : error && !current ? (
        <LoadFailedState error={error} entity="AI assistant settings" onRetry={() => void reload()} />
      ) : current ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <FormControlLabel
            control={
              <Switch
                checked={current.enabled}
                onChange={(e) => void save({ ...current, enabled: e.target.checked })}
                disabled={saveState === 'saving'}
              />
            }
            label={
              <Box>
                <Typography>Allow AI assistants</Typography>
                <Typography variant="body2" color="text.secondary">
                  Assistants can read this company&apos;s jobs, quotes, parts, customers and stock.
                </Typography>
              </Box>
            }
          />
          <FormControlLabel
            control={
              <Switch
                checked={current.enabled && current.writes}
                onChange={(e) => void save({ ...current, writes: e.target.checked })}
                disabled={!current.enabled || saveState === 'saving'}
              />
            }
            label={
              <Box>
                <Typography>Allow changes</Typography>
                <Typography variant="body2" color="text.secondary">
                  Assistants can create and update records when asked, like a quote or a stock move.
                  Off means read only.
                </Typography>
              </Box>
            }
          />
          <Box>
            <Button component={Link} href={`/dashboard/${companyId}/ai-assistants`} variant="outlined">
              Connect your assistant
            </Button>
          </Box>
        </Box>
      ) : null}
    </SettingsSection>
  );
}
