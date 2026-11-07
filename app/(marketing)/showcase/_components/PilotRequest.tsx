'use client';

import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import posthog from 'posthog-js';
import * as Sentry from '@sentry/nextjs';
import type { SxProps, Theme } from '@mui/material/styles';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import UploadFileIcon from '@mui/icons-material/UploadFile';

import BusyButton from '@/components/common/BusyButton';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import { isValidEmail } from '@/lib/validators';
import { toError } from '@/lib/supabaseErrors';
import {
  PILOT_FIELD_LIMITS,
  PILOT_FILE_ACCEPT,
  PILOT_FILE_FORMATS_LABEL,
  PILOT_HONEYPOT_FIELD,
  PILOT_MAX_FILE_LABEL,
  pilotFileProblem,
  pilotFileType,
} from '@/lib/pilotRequest';
import {
  PilotRequestError,
  completePilotRequest,
  createPilotRequest,
  uploadPilotFile,
  type PilotUpload,
} from '@/lib/pilotRequestClient';

export interface PilotRequestProps {
  /** DOM id on the card, for an in-page link such as `#pilot-request`. */
  id?: string;
  /** Layout from the page that places it (width, margins). The card styles itself. */
  sx?: SxProps<Theme>;
}

type Phase = 'idle' | 'preparing' | 'uploading' | 'finishing' | 'done' | 'error';

/**
 * Where a retry picks up. Kept across an error so "Try again" resumes rather than restarts: a
 * failed upload re-uses its signed URL instead of minting a second request (which would also
 * spend one of the visitor's rate-limit slots), and a failed confirmation re-confirms without
 * sending 50 MB again. Keyed on everything that was submitted, so editing a field after an error
 * starts a fresh request instead of uploading under the old details.
 */
interface Attempt {
  key: string;
  requestId: string;
  upload: PilotUpload;
  uploaded: boolean;
}

const GENERIC_MESSAGE = 'Something went wrong sending your part. Please try again.';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * "Send us your part": the showcase's lead form. A visitor sends one part file and an email
 * address; the Jigged team prepares a walkthrough of that part and writes back. Price is not
 * asked here — the follow-up email asks it.
 *
 * Three calls (lib/pilotRequestClient.ts): the server records the request and hands back a signed
 * upload URL, the browser PUTs the file straight to Storage with progress, and the server checks
 * the file arrived before anyone is emailed. Public page, so it works on a phone as well as a desk:
 * every control is a theme Button or TextField, both floored at the 48px target by the theme.
 */
export default function PilotRequest({ id = 'pilot-request', sx }: PilotRequestProps) {
  const headingId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attempt = useRef<Attempt | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [note, setNote] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');

  const busy = phase === 'preparing' || phase === 'uploading' || phase === 'finishing';
  const fileProblem = file ? pilotFileProblem(file) : null;
  const emailValid = isValidEmail(email);
  const missing = [
    ...(!file ? ['Choose your part file'] : fileProblem ? ['Choose a file we can take'] : []),
    ...(!emailValid ? ['Enter your email address'] : []),
  ];

  const onFileChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    // Cleared so picking the same file again after an error still fires onChange.
    event.target.value = '';
    if (chosen) setFile(chosen);
  };

  const reset = () => {
    attempt.current = null;
    setFile(null);
    setEmail('');
    setName('');
    setCompany('');
    setNote('');
    setHoneypot('');
    setEmailTouched(false);
    setProgress(0);
    setErrorMessage('');
    setPhase('idle');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setEmailTouched(true);
    if (busy || !file || fileProblem || !emailValid) return;

    const key = JSON.stringify([file.name, file.size, file.lastModified, email, name, company, note]);
    let current = attempt.current?.key === key ? attempt.current : null;
    setErrorMessage('');

    try {
      if (!current) {
        setPhase('preparing');
        const created = await createPilotRequest({
          email,
          name: name || null,
          company_name: company || null,
          note: note || null,
          file_name: file.name,
          file_size: file.size,
          [PILOT_HONEYPOT_FIELD]: honeypot,
        });
        // The server's answer to a filled honeypot: say thanks, send nothing.
        if (!created.request_id || !created.upload) {
          setPhase('done');
          return;
        }
        current = { key, requestId: created.request_id, upload: created.upload, uploaded: false };
        attempt.current = current;
      }

      if (!current.uploaded) {
        setProgress(0);
        setPhase('uploading');
        await uploadPilotFile(current.upload, file, setProgress);
        current.uploaded = true;
      }

      setPhase('finishing');
      await completePilotRequest(current.requestId);
      attempt.current = null;

      // Shape only — never the email, name, company, note or file name (docs/telemetry.md).
      posthog.capture('pilot request submitted', {
        file_type: pilotFileType(file.name),
        has_name: name.trim() !== '',
        has_company: company.trim() !== '',
        has_note: note.trim() !== '',
      });
      setPhase('done');
    } catch (err) {
      const failure = err instanceof PilotRequestError ? err : null;
      if (!failure || failure.reportable) {
        Sentry.captureException(toError(err, 'Pilot request failed'), {
          tags: {
            pilot_request_stage: failure?.stage ?? 'unknown',
            pilot_request_status: String(failure?.status ?? 'none'),
          },
        });
      }
      // Decide where "Try again" resumes. A request that was never created, or an upload the
      // server refused (an expired or rejected URL will not get better), starts over; a dropped
      // connection re-uses the same URL; a confirmation that found no file re-uploads.
      if (failure?.stage === 'upload' && failure.status !== 0) attempt.current = null;
      if (failure?.stage === 'complete' && failure.status === 409 && attempt.current) {
        attempt.current.uploaded = false;
      }
      setErrorMessage(failure?.message ?? GENERIC_MESSAGE);
      setPhase('error');
    }
  };

  const pendingLabel =
    phase === 'uploading'
      ? `Uploading ${Math.round(progress * 100)}%…`
      : phase === 'finishing'
        ? 'Finishing up…'
        : 'Getting ready…';

  return (
    <Card component="section" id={id} aria-labelledby={headingId} sx={sx}>
      <CardContent sx={{ p: { xs: 2.5, md: 4 } }}>
        <Typography id={headingId} variant="h5" component="h2" sx={{ fontWeight: 600, mb: 1 }}>
          Get a walkthrough of your own part
        </Typography>

        {phase === 'done' ? (
          <Stack spacing={2} role="status" sx={{ pt: 1 }}>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <CheckCircleOutlineIcon color="success" />
              <Typography variant="h6" component="p">
                Thanks — your part is with us.
              </Typography>
            </Stack>
            <Typography color="text.secondary">
              We&apos;ll prepare a walkthrough of your part and be in touch at{' '}
              <Box component="strong" sx={{ color: 'text.primary', wordBreak: 'break-all' }}>
                {email}
              </Box>
              .
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Only the Jigged team will open your file, and we&apos;ll delete it whenever you ask.
            </Typography>
            <Box>
              <Button variant="text" onClick={reset}>
                Send another part
              </Button>
            </Box>
          </Stack>
        ) : (
          <Box component="form" noValidate onSubmit={submit}>
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              Send us a part file and we&apos;ll prepare a walkthrough of your part and be in touch.
            </Typography>

            <Stack spacing={2.5}>
              {/* The file. A real <button> that clicks a hidden input, NOT `component="label"`:
                  ButtonBase forwards Enter on a non-native button only to an onClick prop, so a
                  label-styled button with no handler cannot be opened from the keyboard. */}
              <Box>
                <Box
                  component="input"
                  ref={fileInputRef}
                  type="file"
                  accept={PILOT_FILE_ACCEPT}
                  onChange={onFileChosen}
                  disabled={busy}
                  tabIndex={-1}
                  aria-hidden="true"
                  sx={{ display: 'none' }}
                />
                <Button
                  variant="outlined"
                  startIcon={<UploadFileIcon />}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  fullWidth
                >
                  {file ? 'Choose a different file' : 'Choose part file'}
                </Button>
                {file ? (
                  <Typography
                    variant="body2"
                    sx={{ mt: 1, wordBreak: 'break-all', color: fileProblem ? 'error.light' : 'text.primary' }}
                  >
                    {file.name} · {formatBytes(file.size)}
                    {fileProblem ? ` — ${fileProblem}` : ''}
                  </Typography>
                ) : null}
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                  {PILOT_FILE_FORMATS_LABEL}, up to {PILOT_MAX_FILE_LABEL}.
                </Typography>
              </Box>

              <TextField
                label="Email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setEmailTouched(true)}
                error={emailTouched && email.trim() !== '' && !emailValid}
                helperText={
                  emailTouched && email.trim() !== '' && !emailValid
                    ? 'Enter a valid email address'
                    : 'Where we send your walkthrough.'
                }
                disabled={busy}
                fullWidth
                slotProps={{ htmlInput: { maxLength: PILOT_FIELD_LIMITS.email } }}
              />

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2.5}>
                <TextField
                  label="Name (optional)"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  fullWidth
                  slotProps={{ htmlInput: { maxLength: PILOT_FIELD_LIMITS.name } }}
                />
                <TextField
                  label="Company (optional)"
                  autoComplete="organization"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  disabled={busy}
                  fullWidth
                  slotProps={{ htmlInput: { maxLength: PILOT_FIELD_LIMITS.company } }}
                />
              </Stack>

              <TextField
                label="Note (optional)"
                placeholder="Anything we should know about this part…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={busy}
                fullWidth
                multiline
                minRows={3}
                slotProps={{ htmlInput: { maxLength: PILOT_FIELD_LIMITS.note } }}
              />

              {/* Honeypot. Out of sight, out of the tab order, out of autofill and out of the
                  accessibility tree; a person never fills it and a form-filling script usually
                  does. Zero-sized rather than display:none, which simple bots learn to skip. */}
              <Box
                aria-hidden="true"
                sx={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}
              >
                <TextField
                  label="Website"
                  name={PILOT_HONEYPOT_FIELD}
                  autoComplete="off"
                  value={honeypot}
                  onChange={(e) => setHoneypot(e.target.value)}
                  slotProps={{ htmlInput: { tabIndex: -1 } }}
                />
              </Box>

              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <LockOutlinedIcon fontSize="small" sx={{ color: 'text.secondary', mt: 0.25 }} />
                <Typography variant="body2" color="text.secondary">
                  Only the Jigged team opens your file. We use it only to make your walkthrough,
                  and we delete it whenever you ask.{' '}
                  <Link href="/privacy" color="inherit" underline="always">
                    Privacy policy
                  </Link>
                </Typography>
              </Stack>

              {phase === 'error' ? (
                <Alert
                  severity="error"
                  action={
                    // The theme paints text buttons primary.light, which fails AA on a tinted
                    // band (design-system.md); the band's own colour plus an underline instead.
                    <Button
                      type="submit"
                      sx={{ color: 'error.light', textDecoration: 'underline', fontWeight: 600 }}
                    >
                      Try again
                    </Button>
                  }
                >
                  {errorMessage}
                </Alert>
              ) : null}

              {!busy ? <MissingFieldsNotice items={missing} title="To send your part:" /> : null}

              <BusyButton
                type="submit"
                variant="contained"
                fullWidth
                disabled={busy || missing.length > 0}
                pending={busy}
                pendingLabel={pendingLabel}
                pendingDetail={
                  phase === 'uploading'
                    ? 'Sending your file to Jigged. A large file can take a few minutes on a slow connection — keep this page open.'
                    : undefined
                }
              >
                Send my part
              </BusyButton>

              {phase === 'uploading' ? (
                <LinearProgress
                  variant="determinate"
                  value={Math.round(progress * 100)}
                  aria-label="Upload progress"
                />
              ) : null}
            </Stack>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
