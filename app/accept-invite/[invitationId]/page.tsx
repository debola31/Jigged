'use client';

/**
 * Invite acceptance.
 *
 * ## Two paths, because there are two kinds of invitee
 *
 * This page used to have exactly one: everybody got "set up your account" with First name, Last
 * name and a password box. That is right for a new hire and wrong for the person it hurt — an
 * existing Jigged user invited to a SECOND company, who already has all three.
 *
 * They cannot be told apart from the link alone. `team-invites` calls
 * `auth.admin.generateLink({ type: 'invite' })`, which fails for an already-registered email, and
 * silently falls back to a magic link. A magic link carries no marker saying "this person already
 * exists" — it just signs them in as their existing auth user and drops them here. So the page has
 * to ask the question itself: `hasAnyCompanyAccess`, backstopped by their auth metadata.
 *
 * What that user used to see: a signup form, and a password field whose helper text invited them to
 * fill it in. Typing their real password got them
 * "New password should be different from the old password" — GoTrue's `same_password`, thrown from
 * `updateUser`. Two things were wrong with that and both are fixed here.
 *
 * ## Order: access first, profile second
 *
 * `updateUser` used to run BEFORE `accept_invitation` and throw, so a password complaint also meant
 * the user never got access to the company — the message named the wrong problem and hid the real
 * one. Access is what the invitee came for; it must not be contingent on a profile write. The RPC
 * runs first now, and a profile failure afterwards leaves them added, told so, and one tap from the
 * company.
 *
 * `accept_invitation` is NOT idempotent — it selects `WHERE status = 'pending'` and raises
 * `Invalid or expired invitation` on a second call. `grantedCompanyId` is what stops a retry after
 * a partial failure from re-running it and reporting that as the problem.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import posthog from 'posthog-js';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';

import { getSupabase } from '@/lib/supabase';
import { toError } from '@/lib/supabaseErrors';
import TermsConsentCheckbox from '@/components/legal/TermsConsentCheckbox';
import { recordTermsAcceptance } from '@/lib/legal/acceptClient';
import { fetchAcceptedVersions, documentsNeedingAcceptance } from '@/utils/termsAccess';
import { setLastCompany, homePathForRole, hasAnyCompanyAccess } from '@/utils/companyAccess';
import { getEdgeFunctionUrl } from '@/lib/supabase';
import { AuthLayout } from '@/components/auth';
import type { Invitation } from '@/types/team';

type PageState = 'loading' | 'no-session' | 'confirm-join' | 'name-prompt' | 'accepting' | 'error';

const MIN_PASSWORD_LENGTH = 6;

/**
 * GoTrue rejects a password change to the password already on the account. On this page that is a
 * no-op, not a failure: the user typed their real password into a box we should not have shown
 * them, and the account already holds exactly that value. Swallowing it is the whole point — it is
 * the error that used to cost people their company access.
 *
 * Matched on `code` first (supabase-js surfaces `same_password`) with the message as a fallback,
 * since the code was added later than some deployed GoTrue versions.
 */
function isSamePasswordError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === 'same_password') return true;
  return /different from the old password/i.test(err.message ?? '');
}

export default function AcceptInvitePage() {
  const router = useRouter();
  const params = useParams();
  const invitationId = params.invitationId as string;

  const [state, setState] = useState<PageState>('loading');
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  /**
   * Whether this person still owes an agreement. THREE states, never a boolean:
   * 'unknown' means the check did not complete, and on this surface that fails
   * toward SHOWING the box. An extra row in an append-only table costs nothing;
   * a missing one costs the record. (The gate makes the opposite call, because
   * there the failure would be blocking someone out.)
   */
  const [needsTerms, setNeedsTerms] = useState<'yes' | 'no' | 'unknown'>('unknown');
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  /** True once the user is recognised as an existing Jigged account (the confirm-join path). */
  const [isExistingUser, setIsExistingUser] = useState(false);
  /** Set only for an invite that actually wrote `invitation_id` into auth metadata. */
  const [hasStaleInvitationMeta, setHasStaleInvitationMeta] = useState(false);
  /**
   * Company id once `accept_invitation` has succeeded. Doubles as the "access is already granted"
   * flag — a retry must not call the non-idempotent RPC again.
   */
  const [grantedCompanyId, setGrantedCompanyId] = useState<string | null>(null);

  const checkSessionAndLoadInvitation = useCallback(async () => {
    const supabase = getSupabase();

    // Handle auth tokens from the invite email redirect.
    // Supabase may use implicit flow (hash fragments) or PKCE (code param).
    // Process these before checking for an existing session.
    if (typeof window !== 'undefined') {
      // Handle hash fragment tokens (implicit flow)
      if (window.location.hash) {
        const hashParams = new URLSearchParams(window.location.hash.substring(1));
        const accessToken = hashParams.get('access_token');
        const refreshToken = hashParams.get('refresh_token');
        if (accessToken) {
          if (refreshToken) {
            await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          } else {
            // Some flows only provide access_token — set it manually
            await supabase.auth.setSession({ access_token: accessToken, refresh_token: '' });
          }
          window.history.replaceState(null, '', window.location.pathname);
        }
      }

      // Handle code param (PKCE flow)
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      if (code) {
        await supabase.auth.exchangeCodeForSession(code);
        window.history.replaceState(null, '', window.location.pathname);
      }
    }

    // Check for authenticated session.
    // If no session yet, wait briefly for async auth state processing.
    let session = (await supabase.auth.getSession()).data.session;

    if (!session) {
      // Wait for auth state change (hash fragment processing may be async)
      // `Session | null` spelled out rather than `typeof session`: inside this
      // `if (!session)` block the narrowed type is `null`, so `typeof session`
      // would type the promise as `Promise<null>` and reject the `resolve(newSession)`
      // below. It compiled before only because the untyped client made `session` `any`.
      session = await new Promise<Session | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 3000);
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, newSession: Session | null) => {
          if (newSession) {
            clearTimeout(timeout);
            subscription.unsubscribe();
            resolve(newSession);
          }
        });
      });
    }

    if (!session) {
      setState('no-session');
      return;
    }

    setUserId(session.user.id);
    setUserEmail(session.user.email ?? '');

    // Pre-fill name from user metadata if available
    const meta = session.user.user_metadata;
    if (meta?.first_name) setFirstName(meta.first_name);
    if (meta?.last_name) setLastName(meta.last_name);
    // `display_name` included because it is what THIS page writes on acceptance, so it is the key
    // most likely to be the only one an established user has. Without it their membership in the
    // new company would be named after their email's local part.
    if (!meta?.first_name && (meta?.display_name || meta?.name || meta?.full_name)) {
      const fullName = (meta.display_name || meta.name || meta.full_name || '').trim();
      const parts = fullName.split(/\s+/);
      if (parts.length >= 2) {
        setFirstName(parts[0]);
        setLastName(parts.slice(1).join(' '));
      } else if (parts.length === 1) {
        setFirstName(parts[0]);
      }
    }
    setHasStaleInvitationMeta(Boolean(meta?.invitation_id));

    // Fetch invitation via edge function (uses service role, bypasses RLS).
    // Direct table queries and RPCs fail due to JWT propagation timing
    // after hash-fragment authentication from the invite email link.
    const inviteUrl = getEdgeFunctionUrl('team-invites');
    let inv: Invitation & { company_name?: string };

    try {
      const res = await fetch(`${inviteUrl}/${invitationId}`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!res.ok) {
        console.error('Invitation fetch failed:', res.status);
        setError('Invitation not found. It may have been revoked or already accepted.');
        setState('error');
        return;
      }

      inv = await res.json();
    } catch (err) {
      console.error('Invitation fetch error:', err);
      setError('Invitation not found. It may have been revoked or already accepted.');
      setState('error');
      return;
    }

    // Check if invitation is still valid
    if (inv.status !== 'pending') {
      if (inv.status === 'accepted') {
        // Already accepted — send them to their home surface, which for an operator
        // is the shop floor rather than a dashboard they'd be bounced straight out of.
        router.replace(homePathForRole(inv.role, inv.company_id));
        return;
      }
      setError(`This invitation has been ${inv.status}. Please contact your admin for a new invitation.`);
      setState('error');
      return;
    }

    if (new Date(inv.expires_at) < new Date()) {
      setError('This invitation has expired. Please contact your admin for a new invitation.');
      setState('error');
      return;
    }

    // Check email matches
    if (session.user.email?.toLowerCase() !== inv.email.toLowerCase()) {
      setError(
        `This invitation was sent to ${inv.email}. You are signed in as ${session.user.email}. Please sign in with the correct email address.`
      );
      setState('error');
      return;
    }

    // Company name comes from the RPC join (bypasses RLS)
    setCompanyName(inv.company_name || '');
    setInvitation(inv);

    // Which of the two paths? Membership of any company means they have completed setup once
    // already, so they have a password and a name and must not be asked for either again.
    //
    // The metadata half of the `||` covers the one case membership misses: someone whose access was
    // removed from every company but whose auth account (and password) still exists. `??` on the
    // throw rather than a swallowed `false` keeps "couldn't check" from silently becoming "brand
    // new user" on a network blip — metadata alone decides, which for a real existing user is
    // populated.
    let established = Boolean(meta?.first_name || meta?.display_name || meta?.full_name || meta?.name);
    if (!established) {
      try {
        established = await hasAnyCompanyAccess(session.user.id);
      } catch (err) {
        console.error('Could not check existing company access; falling back to auth metadata:', err);
      }
    }
    setIsExistingUser(established);
    setState(established ? 'confirm-join' : 'name-prompt');
  }, [invitationId, router]);

  useEffect(() => {
    // False positive: checkSessionAndLoadInvitation is an async auth
    // orchestration (token exchange → session → invitation fetch) and every
    // setState inside it runs AFTER an await, never synchronously in this
    // effect body — so it can't cause the cascading-render the rule guards.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkSessionAndLoadInvitation();
  }, [checkSessionAndLoadInvitation]);

  /**
   * Grant access, then write the profile. Shared by both paths so the ordering guarantee — and the
   * retry guard on the non-idempotent RPC — cannot drift between them.
   *
   * `newPassword` is only ever passed on the new-user path.
   */
  async function acceptAndRedirect(fullName: string, newPassword?: string) {
    if (!invitation || !userId) return;

    setState('accepting');
    setError(null);

    const supabase = getSupabase();

    try {
      // 1. Access first. Skipped if a previous attempt already got this far.
      let companyId = grantedCompanyId;
      if (!companyId) {
        const { data, error: rpcError } = await supabase.rpc('accept_invitation', {
          p_invitation_id: invitation.id,
          p_user_id: userId,
        });

        if (rpcError) {
          throw new Error(rpcError.message || 'Failed to accept invitation');
        }
        companyId = data as string;
        setGrantedCompanyId(companyId);
      }

      // 2. Profile and password. A failure here no longer costs the user their access.
      const updatePayload: { password?: string; data?: Record<string, string | null> } = {};
      if (newPassword) {
        updatePayload.password = newPassword;
      }
      if (!isExistingUser) {
        updatePayload.data = {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          display_name: fullName,
          // Clear invitation_id so the auth callback fallback doesn't
          // redirect here on future logins
          invitation_id: null,
        };
      } else if (hasStaleInvitationMeta) {
        // An existing user keeps the name they already chose; the only thing worth clearing is a
        // stale redirect marker, and only when one was actually written.
        updatePayload.data = { invitation_id: null };
      }

      if (updatePayload.password || updatePayload.data) {
        const { error: updateError } = await supabase.auth.updateUser(updatePayload);
        if (updateError && !isSamePasswordError(updateError)) {
          throw new Error(updateError.message || 'Failed to update account');
        }
      }

      // 3. Name on the team record.
      const { data: { session } } = await supabase.auth.getSession();

      if (session) {
        const teamUrl = getEdgeFunctionUrl('team');
        const { data: members } = await supabase
          .from('user_company_access')
          .select('id')
          .eq('user_id', userId)
          .eq('company_id', companyId)
          .single();

        if (members) {
          await fetch(`${teamUrl}/${members.id}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ name: fullName }),
          });
        }
      }

      // Set as last company
      await setLastCompany(userId, companyId);

      // The clickwrap record. Placed HERE -- after access, before the redirect --
      // and deliberately best-effort.
      //
      // The ordering above is load-bearing (see the header comment) and
      // accept_invitation is not idempotent, so access must not become
      // contingent on a later write. If this fails, the invitee is a member with
      // no acceptance row, which TermsGate notices on their very next page load
      // and collects through the same server path, with NO special case. That
      // one-code-path property is exactly what makes best-effort safe here.
      //
      // captureException IS correct: this is a fetch, not a Supabase .from(), so
      // the Sentry Supabase integration does not cover it.
      try {
        await recordTermsAcceptance({ acceptedVia: 'invite_accept', companyId });
      } catch (termsErr) {
        Sentry.captureException(toError(termsErr, 'Failed to record terms acceptance'), {
          tags: { area: 'legal-acceptance', surface: 'invite_accept' },
        });
      }

      posthog.identify(userId, { email: invitation.email });
      posthog.capture('invitation accepted', {
        role: invitation.role,
        existing_user: isExistingUser,
      });

      // Straight to the surface the invited role actually works on. A new operator's
      // very first screen used to be a dashboard flash before AuthGuard corrected it.
      router.replace(homePathForRole(invitation.role, companyId));
    } catch (err) {
      console.error('Error accepting invitation:', err);
      setError(err instanceof Error ? err.message : 'Failed to accept invitation');
      setState(isExistingUser ? 'confirm-join' : 'name-prompt');
    }
  }

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    fetchAcceptedVersions(userId)
      .then((rows) => {
        if (!cancelled) setNeedsTerms(documentsNeedingAcceptance(rows).length ? 'yes' : 'no');
      })
      .catch(() => {
        // "Couldn't check" is never "already agreed".
        if (!cancelled) setNeedsTerms('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  /** Existing account: one tap, nothing to fill in. */
  async function handleJoin() {
    // Name comes from what their account already knows. Falls back to the local part of the
    // invited email so the team list never shows a blank row.
    if (needsTerms !== 'no' && !termsAccepted) {
      setError('Please agree to the Terms of Service and Privacy Policy');
      return;
    }
    const fromMetadata = `${firstName.trim()} ${lastName.trim()}`.trim();
    const fullName = fromMetadata || (invitation?.email.split('@')[0] ?? '');
    await acceptAndRedirect(fullName);
  }

  /** Not you? Leave, so the right account can accept. */
  async function handleSignOut() {
    const supabase = getSupabase();
    await supabase.auth.signOut({ scope: 'local' });
    router.push(`/login?returnTo=/accept-invite/${invitationId}`);
  }

  /** Brand-new account: name and password are both required, because neither exists yet. */
  async function handleAccept(e: React.FormEvent) {
    e.preventDefault();

    if (!firstName.trim() || !lastName.trim()) {
      setError('First name and last name are required');
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (!termsAccepted) {
      setError('Please agree to the Terms of Service and Privacy Policy');
      return;
    }

    await acceptAndRedirect(`${firstName.trim()} ${lastName.trim()}`, password);
  }

  const roleLabel = invitation?.role === 'admin' ? 'Admin' : invitation?.role === 'operator' ? 'Operator' : 'User';

  // Loading state
  if (state === 'loading') {
    return (
      <AuthLayout>
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      </AuthLayout>
    );
  }

  // No session — redirect to login
  if (state === 'no-session') {
    return (
      <AuthLayout>
        <Card elevation={3}>
          <CardContent sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="h5" gutterBottom>
              Sign In Required
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
              Please sign in to accept your team invitation.
            </Typography>
            <Button
              variant="contained"
              onClick={() => router.push(`/login?returnTo=/accept-invite/${invitationId}`)}
            >
              Sign In
            </Button>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  // Error state
  if (state === 'error') {
    return (
      <AuthLayout>
        <Card elevation={3}>
          <CardContent sx={{ p: 4 }}>
            <Typography variant="h5" gutterBottom>
              Invitation Problem
            </Typography>
            <Alert severity="error" sx={{ mb: 3 }}>
              {error}
            </Alert>
            <Button variant="outlined" onClick={() => router.push('/login')}>
              Go to Login
            </Button>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  // Accepting state
  if (state === 'accepting') {
    return (
      <AuthLayout>
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography>Joining {companyName || 'team'}...</Typography>
        </Box>
      </AuthLayout>
    );
  }

  /*
   * Shown to anyone who already has a Jigged account. No name fields and no password field —
   * asking for either is what this whole change exists to stop. The single button is a deliberate
   * stop rather than an automatic join: it is where the invitee sees WHICH company and WHICH role
   * they are accepting, and it keeps a mail-client link prefetch from joining them silently.
   */
  if (state === 'confirm-join') {
    return (
      <AuthLayout>
        <Card elevation={3}>
          <CardContent sx={{ p: 4 }}>
            <Typography variant="h5" component="h2" gutterBottom align="center">
              Join {companyName || 'Your Team'}
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'center', mb: 3 }}>
              <Chip label={roleLabel} color="primary" />
            </Box>

            {error && (
              <Alert severity={grantedCompanyId ? 'warning' : 'error'} sx={{ mb: 3 }}>
                {grantedCompanyId
                  ? `You've been added to ${companyName || 'the company'}, but we couldn't finish updating your account: ${error}`
                  : error}
              </Alert>
            )}

            <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 1 }}>
              You already have a Jigged account. Your name and password carry over — there is
              nothing to set up.
            </Typography>
            {userEmail && (
              <Typography variant="caption" color="text.secondary" align="center" sx={{ display: 'block', mb: 3 }}>
                Signed in as {userEmail}
              </Typography>
            )}

            {/*
              An existing user joining a SECOND company has already agreed, as a
              natural person, to the current documents -- consent is by the
              person, not by the membership, so re-asking someone who is already
              current reads as broken software. The box appears only when they
              are genuinely behind. An UNKNOWN status fails toward SHOWING it:
              an extra row in an append-only table costs nothing, a missing one
              costs the record.
            */}
            {needsTerms !== 'no' && (
              <>
                <TermsConsentCheckbox
              checked={termsAccepted}
              onChange={setTermsAccepted}
              surface="invite_accept"
            />
              </>
            )}

            <Button
              variant="contained"
              fullWidth
              size="large"
              disabled={needsTerms !== 'no' && !termsAccepted}
              sx={{ mt: 2 }}
              onClick={grantedCompanyId
                ? () => router.replace(homePathForRole(invitation?.role, grantedCompanyId))
                : handleJoin}
            >
              {grantedCompanyId ? 'Continue' : `Join ${companyName || 'Team'}`}
            </Button>

            <Box sx={{ textAlign: 'center', mt: 2 }}>
              <Button onClick={handleSignOut} size="small" sx={{ textTransform: 'none' }}>
                Not you? Sign out
              </Button>
            </Box>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  // Account setup — new users only, which is why the password is now required rather than
  // "leave blank if you already have one". Blank no longer means "I have one already"; it means an
  // account reachable only by emailed magic link.
  return (
    <AuthLayout>
      <Card elevation={3}>
        <CardContent sx={{ p: 4 }}>
          <Typography variant="h5" component="h2" gutterBottom align="center">
            Join {companyName || 'Your Team'}
          </Typography>
          <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 1 }}>
            Set up your account to get started.
          </Typography>
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 3 }}>
            <Chip label={roleLabel} color="primary" />
          </Box>

          {error && (
            <Alert severity={grantedCompanyId ? 'warning' : 'error'} sx={{ mb: 3 }}>
              {grantedCompanyId
                ? `You've been added to ${companyName || 'the company'}, but we couldn't finish setting up your account: ${error}`
                : error}
            </Alert>
          )}

          {grantedCompanyId && (
            <Button
              variant="outlined"
              fullWidth
              sx={{ mb: 3 }}
              onClick={() => router.replace(homePathForRole(invitation?.role, grantedCompanyId))}
            >
              Continue to {companyName || 'your team'}
            </Button>
          )}

          <Box component="form" onSubmit={handleAccept}>
            <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
              <TextField
                label="First Name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                fullWidth
                required
                autoFocus
                autoComplete="given-name"
                sx={{ flex: 1 }}
              />
              <TextField
                label="Last Name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                fullWidth
                required
                autoComplete="family-name"
                sx={{ flex: 1 }}
              />
            </Box>

            <TextField
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              fullWidth
              required
              sx={{ mb: 2 }}
              autoComplete="new-password"
              helperText={`At least ${MIN_PASSWORD_LENGTH} characters.`}
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton onClick={() => setShowPassword(!showPassword)} edge="end" size="small">
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />

            <TextField
              label="Confirm Password"
              type={showConfirmPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              fullWidth
              required
              sx={{ mb: 3 }}
              autoComplete="new-password"
              error={confirmPassword !== '' && password !== confirmPassword}
              helperText={
                confirmPassword !== '' && password !== confirmPassword
                  ? 'Passwords do not match'
                  : ''
              }
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton onClick={() => setShowConfirmPassword(!showConfirmPassword)} edge="end" size="small">
                        {showConfirmPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />

            <TermsConsentCheckbox
              checked={termsAccepted}
              onChange={setTermsAccepted}
              surface="invite_accept"
            />

            <Button
              type="submit"
              variant="contained"
              fullWidth
              size="large"
              disabled={!termsAccepted}
              sx={{ mt: 2 }}
            >
              Accept Invitation
            </Button>
          </Box>
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
