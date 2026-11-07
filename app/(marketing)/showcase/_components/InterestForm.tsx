'use client';

import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import FormControlLabel from '@mui/material/FormControlLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import UploadFileIcon from '@mui/icons-material/UploadFile';

import { submitWaitlist } from '@/app/actions/waitlist';
import BusyButton from '@/components/common/BusyButton';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import { isValidEmail } from '@/lib/validators';
import { GENERIC_ALERT_MESSAGE, SKEW_ALERT_MESSAGE, reportWaitlistSubmitFailure } from '@/lib/serverActionSkew';
import { PILOT_FILE_ACCEPT, PILOT_FILE_FORMATS_LABEL, pilotFileType } from '@/lib/pilotRequest';

/** What the visitor asks for, and the waitlist `source` it is recorded under (notify-waitlist reads it). */
export const INTEREST = {
  feature: { source: 'showcase_feature_request', label: 'Request this feature', button: 'Request it' },
  pilot: { source: 'showcase_pilot', label: 'Join the pilot', button: 'Join the pilot' },
} as const;
type Intent = keyof typeof INTEREST;

type Status = 'idle' | 'loading' | 'success' | 'error' | 'stale';

/**
 * "Your own part": the visitor picks their part's file, learns a walkthrough of their own part
 * isn't automatic yet, and either asks for the feature or commits to the pilot, with their name,
 * business and email. It goes on the Jigged waitlist (app/actions/waitlist.ts) under its own
 * `source`; the notify-waitlist function tells the team and sends the visitor a confirmation that
 * matches what they asked for.
 *
 * The file never leaves the visitor's computer: only that they have a part matters here, and the
 * team asks for the file when it follows up. So nothing about it is sent, not even its name.
 */
export default function InterestForm() {
  const headingId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  // Only its kind matters: nothing is uploaded, so the upload form's size limit doesn't apply.
  const fileProblem = file && !pilotFileType(file.name) ? `Choose a ${PILOT_FILE_FORMATS_LABEL}.` : null;
  const emailValid = isValidEmail(email);
  const busy = status === 'loading';
  const missing = [
    ...(!intent ? ['Choose what you would like'] : []),
    ...(!name.trim() ? ['Enter your name'] : []),
    ...(!company.trim() ? ['Enter your business'] : []),
    ...(!emailValid ? ['Enter your email address'] : []),
  ];

  const onFileChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0] ?? null;
    event.target.value = ''; // so choosing the same file again still fires onChange
    if (chosen) setFile(chosen);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setEmailTouched(true);
    if (busy || !intent || missing.length > 0) return;
    const { source } = INTEREST[intent];
    setStatus('loading');
    setMessage('');
    try {
      const result = await submitWaitlist({
        email: email.trim().toLowerCase(),
        name: name.trim(),
        company_name: company.trim(),
        shop_size: null,
        source,
      });
      if (result.error) throw new Error(result.error);
      // Shape only, as the waitlist's other form sends it: never the name, business, email or file.
      posthog.capture('waitlist submitted', { source, shop_size: null });
      setStatus('success');
    } catch (err) {
      const isSkew = reportWaitlistSubmitFailure(err, source);
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

        {status === 'success' && intent ? (
          <Stack spacing={2} role="status" sx={{ pt: 1 }}>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <CheckCircleOutlineIcon color="success" />
              <Typography variant="h6" component="p">
                {intent === 'pilot' ? "Thanks — you're in the pilot." : "Thanks — you're on the list."}
              </Typography>
            </Stack>
            <Typography color="text.secondary">
              {intent === 'pilot'
                ? "We'll be in touch to set up a walkthrough of your part for your shop, at "
                : "We'll let you know when you can make walkthroughs of your own parts, at "}
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
                    Walkthroughs of your own parts aren&apos;t automatic yet. Tell us you want one:
                  </Typography>
                  <RadioGroup
                    aria-label="What you would like"
                    value={intent ?? ''}
                    onChange={(e) => setIntent(e.target.value as Intent)}
                  >
                    <FormControlLabel
                      value="feature"
                      disabled={busy}
                      control={<Radio />}
                      label={
                        <Box sx={{ py: 1 }}>
                          <Typography sx={{ fontWeight: 600 }}>{INTEREST.feature.label}</Typography>
                          <Typography variant="body2" color="text.secondary">
                            We&apos;ll let you know when you can make walkthroughs of your own parts.
                          </Typography>
                        </Box>
                      }
                    />
                    <FormControlLabel
                      value="pilot"
                      disabled={busy}
                      control={<Radio />}
                      label={
                        <Box sx={{ py: 1 }}>
                          <Typography sx={{ fontWeight: 600 }}>{INTEREST.pilot.label}</Typography>
                          <Typography variant="body2" color="text.secondary">
                            Work with us now: we&apos;ll make a walkthrough of this part with your machines and
                            tools.
                          </Typography>
                        </Box>
                      }
                    />
                  </RadioGroup>

                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2.5}>
                    <TextField
                      label="Name"
                      required
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={busy}
                      fullWidth
                      slotProps={{ htmlInput: { maxLength: 200 } }}
                    />
                    <TextField
                      label="Business"
                      required
                      autoComplete="organization"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      disabled={busy}
                      fullWidth
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
                    error={emailTouched && email.trim() !== '' && !emailValid}
                    helperText={emailTouched && email.trim() !== '' && !emailValid ? 'Enter a valid email address' : undefined}
                    disabled={busy}
                    fullWidth
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

                  {!busy ? <MissingFieldsNotice items={missing} title="To send this:" /> : null}

                  <BusyButton
                    type="submit"
                    variant="contained"
                    fullWidth
                    disabled={busy || missing.length > 0}
                    pending={busy}
                    pendingLabel="Sending…"
                  >
                    {intent ? INTEREST[intent].button : 'Send'}
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
