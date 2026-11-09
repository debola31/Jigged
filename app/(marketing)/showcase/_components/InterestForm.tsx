'use client';

import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import UploadFileIcon from '@mui/icons-material/UploadFile';

import { submitWaitlist } from '@/app/actions/waitlist';
import BusyButton from '@/components/common/BusyButton';
import { isValidEmail } from '@/lib/validators';
import { GENERIC_ALERT_MESSAGE, SKEW_ALERT_MESSAGE, reportWaitlistSubmitFailure } from '@/lib/serverActionSkew';
import { PILOT_FILE_ACCEPT, PILOT_FILE_FORMATS_LABEL, pilotFileExtension, pilotFileType } from '@/lib/pilotRequest';

/** The waitlist `source` a pilot sign-up is recorded under; notify-waitlist reads it to pick the confirmation. */
export const PILOT_SOURCE = 'showcase_pilot';

type Status = 'idle' | 'loading' | 'success' | 'error' | 'stale';

/**
 * "Your own part": the visitor picks their part's file, learns a walkthrough of their own part
 * isn't automatic yet, and joins the pilot with their name, business and email. It goes on the
 * Jigged waitlist (app/actions/waitlist.ts) under its own `source`; the notify-waitlist function
 * tells the team and sends the visitor the pilot confirmation.
 *
 * The button stays enabled: pressing it with a field blank marks that field and moves focus to
 * it, so what's missing shows where it's fixed, with no separate list of the fields.
 *
 * The file never leaves the visitor's computer: only that they have a part matters here, and the
 * team asks for the file when it follows up. So nothing about it is sent, not even its name.
 */
export default function InterestForm() {
  const headingId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const companyRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  // Only its kind matters: nothing is uploaded, so the upload form's size limit doesn't apply.
  const fileProblem = file && !pilotFileType(file.name) ? `Choose a ${PILOT_FILE_FORMATS_LABEL}.` : null;
  const emailValid = isValidEmail(email);
  const busy = status === 'loading';

  const nameError = attempted && !name.trim() ? 'Enter your name' : undefined;
  const companyError = attempted && !company.trim() ? 'Enter your business' : undefined;
  const emailError = emailValid
    ? undefined
    : email.trim() !== '' && (emailTouched || attempted)
      ? 'Enter a valid email address'
      : attempted
        ? 'Enter your email address'
        : undefined;

  const onFileChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    event.target.value = ''; // so choosing the same file again still fires onChange
    if (!chosen) return;
    setFile(chosen);
    // Its format only, never its name: what shops reach for decides which formats get read first.
    posthog.capture('pilot file chosen', {
      file_type: pilotFileType(chosen.name) ?? 'unsupported',
      extension: pilotFileExtension(chosen.name),
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    const firstMissing = !name.trim() ? nameRef : !company.trim() ? companyRef : !emailValid ? emailRef : null;
    if (firstMissing) {
      firstMissing.current?.focus();
      return;
    }
    setStatus('loading');
    setMessage('');
    try {
      const result = await submitWaitlist({
        email: email.trim().toLowerCase(),
        name: name.trim(),
        company_name: company.trim(),
        shop_size: null,
        source: PILOT_SOURCE,
      });
      if (result.error) throw new Error(result.error);
      // Shape only, as the waitlist's other form sends it: never the name, business, email or file.
      posthog.capture('waitlist submitted', { source: PILOT_SOURCE, shop_size: null });
      setStatus('success');
    } catch (err) {
      const isSkew = reportWaitlistSubmitFailure(err, PILOT_SOURCE);
      setStatus(isSkew ? 'stale' : 'error');
      setMessage(isSkew ? SKEW_ALERT_MESSAGE : GENERIC_ALERT_MESSAGE);
    }
  };

  return (
    <Card component="section" aria-labelledby={headingId}>
      <CardContent sx={{ p: { xs: 2.5, md: 4 } }}>
        <Typography id={headingId} variant="h5" component="h2" sx={{ fontWeight: 600, mb: 1 }}>
          Your own part
        </Typography>

        {status === 'success' ? (
          <Stack spacing={2} role="status" sx={{ pt: 1 }}>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <CheckCircleOutlineIcon color="success" />
              <Typography variant="h6" component="p">
                Thanks — you&apos;re in the pilot.
              </Typography>
            </Stack>
            <Typography color="text.secondary">
              We&apos;ll be in touch to set up a walkthrough of your part for your shop, at{' '}
              <Box component="strong" sx={{ color: 'text.primary', wordBreak: 'break-all' }}>
                {email.trim().toLowerCase()}
              </Box>
              .
            </Typography>
          </Stack>
        ) : (
          <Box component="form" noValidate onSubmit={submit}>
            <Stack spacing={2.5}>
              <Box>
                <Box
                  component="input"
                  ref={fileInputRef}
                  type="file"
                  accept={PILOT_FILE_ACCEPT}
                  onChange={onFileChosen}
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
                  {file ? 'Choose a different file' : 'Choose your part file'}
                </Button>
                {file ? (
                  <Typography
                    variant="body2"
                    sx={{ mt: 1, wordBreak: 'break-all', color: fileProblem ? 'error.light' : 'text.primary' }}
                  >
                    {file.name}
                    {fileProblem ? ` — ${fileProblem}` : ''}
                  </Typography>
                ) : (
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                    {PILOT_FILE_FORMATS_LABEL}.
                  </Typography>
                )}
              </Box>

              {file && !fileProblem ? (
                <>
                  <Typography color="text.secondary">
                    Walkthroughs of your own parts aren&apos;t automatic yet. Join the pilot and we&apos;ll make one
                    of this part with your machines and tools.
                  </Typography>

                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2.5}>
                    <TextField
                      label="Name"
                      required
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      error={Boolean(nameError)}
                      helperText={nameError}
                      disabled={busy}
                      fullWidth
                      inputRef={nameRef}
                      slotProps={{ htmlInput: { maxLength: 200 } }}
                    />
                    <TextField
                      label="Business"
                      required
                      autoComplete="organization"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      error={Boolean(companyError)}
                      helperText={companyError}
                      disabled={busy}
                      fullWidth
                      inputRef={companyRef}
                      slotProps={{ htmlInput: { maxLength: 200 } }}
                    />
                  </Stack>
                  <TextField
                    label="Email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onBlur={() => setEmailTouched(true)}
                    error={Boolean(emailError)}
                    helperText={emailError}
                    disabled={busy}
                    fullWidth
                    inputRef={emailRef}
                    slotProps={{ htmlInput: { maxLength: 320 } }}
                  />

                  <Stack direction="row" spacing={1.5} alignItems="flex-start">
                    <LockOutlinedIcon fontSize="small" sx={{ color: 'text.secondary', mt: 0.25 }} />
                    <Typography variant="body2" color="text.secondary">
                      Your file stays on your computer: we don&apos;t upload it. We&apos;ll ask for it when we
                      follow up.
                    </Typography>
                  </Stack>

                  {status === 'error' || status === 'stale' ? <Alert severity="error">{message}</Alert> : null}

                  <BusyButton
                    type="submit"
                    variant="contained"
                    fullWidth
                    disabled={busy}
                    pending={busy}
                    pendingLabel="Sending…"
                  >
                    Join the pilot
                  </BusyButton>
                </>
              ) : null}
            </Stack>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
