'use client';

import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import SaveIcon from '@mui/icons-material/Save';

import {
  getCompany,
  updateCompanyShippingSettings,
} from '@/utils/companyAccess';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';

interface CompanyShippingSettingsCardProps {
  companyId: string;
}

/**
 * Live-format preview. Substitutes {YYYY} → current year and
 * {seq:0...0} → the sample sequence, padded to the zero count.
 */
function previewFormat(format: string, year: number, seq: number): string {
  let out = format.replace('{YYYY}', String(year));
  const m = /\{seq:(0+)\}/.exec(out);
  if (m) {
    const width = m[1].length;
    out = out.replace(/\{seq:0+\}/, String(seq).padStart(width, '0'));
  } else {
    out = out.replace('{seq}', String(seq));
  }
  return out;
}

export default function CompanyShippingSettingsCard({ companyId }: CompanyShippingSettingsCardProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);

  const [format, setFormat] = useState('');
  const [originalFormat, setOriginalFormat] = useState('');
  const [coc, setCoc] = useState('');
  const [originalCoc, setOriginalCoc] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const company = await getCompany(companyId);
        if (cancelled || !company) return;
        const f = company.packing_slip_number_format ?? 'PS-{YYYY}-{seq:0000}';
        const c = company.default_coc_text ?? '';
        setFormat(f);
        setOriginalFormat(f);
        setCoc(c);
        setOriginalCoc(c);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load company.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const dirty = format !== originalFormat || coc !== originalCoc;
  const formatValid = /\{seq(:0+)?\}/.test(format);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateCompanyShippingSettings(companyId, {
        packing_slip_number_format: format,
        default_coc_text: coc.trim() ? coc.trim() : null,
      });
      setOriginalFormat(format);
      setOriginalCoc(coc);
      setSavedTick((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card elevation={2}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        </CardContent>
      </Card>
    );
  }

  const year = new Date().getFullYear();
  const preview = formatValid ? previewFormat(format, year, 42) : '(format invalid)';

  return (
    <Card elevation={2}>
      <CardContent>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Shipping
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Packing-slip number template + default Certificate of Conformance text.
        </Typography>
        <Divider sx={{ mb: 2 }} />

        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          {savedTick > 0 && !dirty && !error && <Alert severity="success">Saved.</Alert>}

          <TextField
            label="Packing-slip Number Format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            fullWidth
            error={!formatValid}
            helperText={
              formatValid
                ? `Preview: ${preview}. Tokens: {YYYY} = year, {seq:0000} = zero-padded sequence (zero count sets width), {seq} = un-padded.`
                : 'Must include {seq} or {seq:0000}.'
            }
          />

          <TextField
            label="Default Certificate of Conformance"
            value={coc}
            onChange={(e) => setCoc(e.target.value)}
            multiline
            minRows={3}
            fullWidth
            helperText="Last step in the CoC cascade (shipment → customer → company → omit)."
          />

          <MissingFieldsNotice
            items={!formatValid ? ['Packing-slip format must include {seq} or {seq:0000}'] : []}
          />

          <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={handleSave}
              disabled={!dirty || saving || !formatValid}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}
