'use client';

/**
 * The page a person sees when they connect an AI assistant (Claude, ChatGPT, …) to Jigged.
 *
 * Supabase Auth's OAuth 2.1 server sends them here with an `authorization_id` after the assistant
 * starts its sign-in. They approve or cancel; Supabase then sends them back to the assistant with
 * a code (or `access_denied`), and the assistant exchanges the code for a token it presents to
 * `/mcp`. Signed-out visitors go through `/login` first and come back here (`returnTo`).
 *
 * WHAT IT SHOWS, AND WHY THE REDIRECT HOST. The assistant's name is whatever it registered under,
 * and registration is open (dynamic client registration), so a name alone proves nothing. The
 * host it will send the person back to (claude.ai, chatgpt.com) is the part a look-alike cannot
 * fake, so it is on screen beside the name.
 *
 * OPERATORS. The MCP server refuses operator logins (lib/mcp/server.ts). Someone who is an
 * operator in every company they belong to can never use the connection, so Allow is not offered
 * at all (interaction-standards §4 rule 3: hide what this role can never do) and the page says
 * why, with the one action that is real: go back to the assistant.
 */

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import posthog from 'posthog-js';
import * as Sentry from '@sentry/nextjs';
import type { OAuthAuthorizationDetails } from '@supabase/supabase-js';

import { useAuth } from '@/components/providers/AuthProvider';
import { useLoad } from '@/hooks/useLoad';
import { getSupabase } from '@/lib/supabase';
import { toError } from '@/lib/supabaseErrors';
import { clientKindOf } from '@/lib/mcp/clientKind';
import { getUserCompanies } from '@/utils/companyAccess';

interface OfficeCompany {
  id: string;
  name: string;
  role: 'admin' | 'user';
}

type Loaded =
  | { kind: 'missing' }
  | { kind: 'expired' }
  | { kind: 'redirecting' }
  | { kind: 'ready'; details: OAuthAuthorizationDetails; companies: OfficeCompany[] };

function returnHost(redirectUri: string): string | null {
  try {
    return new URL(redirectUri).host;
  } catch {
    return null;
  }
}

export function consentPath(authorizationId: string): string {
  return `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
}

export default function OAuthConsent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const authorizationId = searchParams.get('authorization_id');
  const { user, loading: authLoading } = useAuth();
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error: loadError } = useLoad<Loaded | null>(
    async () => {
      if (authLoading) return null;
      if (!authorizationId) return { kind: 'missing' };
      if (!user) {
        // Signed out: sign in first, then come straight back to this exact request.
        router.replace(`/login?returnTo=${encodeURIComponent(consentPath(authorizationId))}`);
        return { kind: 'redirecting' };
      }
      const supabase = getSupabase();
      const { data: details, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      if (error || !details) return { kind: 'expired' };
      if (!('authorization_id' in details)) {
        // Already approved earlier for this assistant: Supabase answers with the redirect at once.
        window.location.assign(details.redirect_url);
        return { kind: 'redirecting' };
      }
      const rows = await getUserCompanies(user.id);
      const companies = rows.flatMap((row): OfficeCompany[] =>
        row.role === 'admin' || row.role === 'user'
          ? [{ id: row.company_id, name: row.companies?.name ?? 'Unnamed company', role: row.role }]
          : [],
      );
      return { kind: 'ready', details, companies };
    },
    [authLoading, user?.id, authorizationId],
    {
      onError: (err) => {
        Sentry.captureException(toError(err));
      },
    },
  );

  async function decide(decision: 'approve' | 'deny', details: OAuthAuthorizationDetails) {
    setSubmitting(decision);
    setActionError(null);
    const oauth = getSupabase().auth.oauth;
    const { error } =
      decision === 'approve'
        ? await oauth.approveAuthorization(details.authorization_id, { skipBrowserRedirect: true }).then(
            (res) => {
              if (!res.error && res.data) {
                posthog.capture('ai assistant connected', { client_kind: clientKindOf(details.client.name) });
                window.location.assign(res.data.redirect_url);
              }
              return res;
            },
          )
        : await oauth.denyAuthorization(details.authorization_id, { skipBrowserRedirect: true }).then((res) => {
            if (!res.error && res.data) window.location.assign(res.data.redirect_url);
            return res;
          });
    if (error) {
      Sentry.captureException(toError(error));
      setSubmitting(null);
      setActionError(
        'Jigged couldn’t finish connecting. Go back to your assistant and start connecting again.',
      );
    }
  }

  async function signOutAndRetry() {
    if (!authorizationId) return;
    await getSupabase().auth.signOut();
    router.replace(`/login?returnTo=${encodeURIComponent(consentPath(authorizationId))}`);
  }

  if (loadError && !loading) {
    return (
      <Card elevation={3}>
        <CardContent sx={{ p: 4 }}>
          <Typography variant="h5" component="h1" gutterBottom>
            Jigged couldn’t load this request
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Check your connection and reload this page, or go back to your AI assistant and start
            connecting again.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  if (authLoading || loading || !data || data.kind === 'redirecting') {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (data.kind === 'missing' || data.kind === 'expired') {
    return (
      <Card elevation={3}>
        <CardContent sx={{ p: 4 }}>
          <Typography variant="h5" component="h1" gutterBottom>
            This connection link has expired
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Go back to your AI assistant and start connecting Jigged again. Each link works once,
            for a few minutes.
          </Typography>
        </CardContent>
      </Card>
    );
  }

  const { details, companies } = data;
  const clientName = details.client.name || 'An AI assistant';
  const host = returnHost(details.redirect_uri);
  const busy = submitting !== null;

  const signedInAs = (
    <Typography variant="body2" color="text.secondary" sx={{ mt: 3, textAlign: 'center' }}>
      Signed in as {details.user.email}.{' '}
      <Button size="small" onClick={signOutAndRetry} disabled={busy} sx={{ textTransform: 'none' }}>
        Not you? Sign out
      </Button>
    </Typography>
  );

  if (companies.length === 0) {
    return (
      <Card elevation={3}>
        <CardContent sx={{ p: 4 }}>
          <Typography variant="h5" component="h1" gutterBottom>
            Your login can’t connect an AI assistant
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
            Only office logins (admins and users) can connect an assistant to Jigged. Your login is an
            operator login in every company you belong to. Ask a company admin if you need office
            access.
          </Typography>
          {actionError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {actionError}
            </Alert>
          )}
          <Button variant="contained" size="large" fullWidth onClick={() => decide('deny', details)} disabled={busy}>
            {submitting === 'deny' ? <CircularProgress size={24} color="inherit" /> : `Back to ${clientName}`}
          </Button>
          {signedInAs}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card elevation={3}>
      <CardContent sx={{ p: 4 }}>
        <Typography variant="h5" component="h1" gutterBottom>
          Connect {clientName} to Jigged
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          {clientName} is asking to work in Jigged as you
          {host ? (
            <>
              {' '}
              and will send you back to <strong>{host}</strong>
            </>
          ) : null}
          .
        </Typography>

        <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
          It will be able to
        </Typography>
        <Box component="ul" sx={{ mt: 1, mb: 3, pl: 3 }}>
          <Typography component="li" variant="body1">
            see your jobs, quotes, parts, customers and inventory
          </Typography>
          <Typography component="li" variant="body1">
            make changes when you ask it to, like creating a quote or moving stock
          </Typography>
        </Box>

        <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
          In {companies.length === 1 ? 'this company' : 'these companies'}
        </Typography>
        <Box component="ul" sx={{ mt: 1, mb: 3, pl: 3 }}>
          {companies.map((c) => (
            <Typography key={c.id} component="li" variant="body1">
              {c.name} <Typography component="span" color="text.secondary">({c.role === 'admin' ? 'Admin' : 'User'})</Typography>
            </Typography>
          ))}
        </Box>

        {actionError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {actionError}
          </Alert>
        )}

        <Button
          variant="contained"
          size="large"
          fullWidth
          onClick={() => decide('approve', details)}
          disabled={busy}
          sx={{ mb: 1.5 }}
        >
          {submitting === 'approve' ? <CircularProgress size={24} color="inherit" /> : 'Allow'}
        </Button>
        <Button variant="outlined" size="large" fullWidth onClick={() => decide('deny', details)} disabled={busy}>
          {submitting === 'deny' ? <CircularProgress size={24} color="inherit" /> : 'Cancel'}
        </Button>
        {signedInAs}
      </CardContent>
    </Card>
  );
}
