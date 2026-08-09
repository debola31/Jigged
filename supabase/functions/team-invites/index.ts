/**
 * Team Invitations Edge Function
 *
 * Handles magic link invitations for team members.
 * Uses Resend API for email delivery (bypasses Supabase email rate limits).
 *
 * Endpoints:
 * - POST /team-invites                    - Send invitation (creates invitation + sends magic link)
 * - GET  /team-invites?company_id=xxx     - List invitations for a company
 * - DELETE /team-invites/:id              - Revoke a pending invitation
 * - POST /team-invites/:id/resend         - Resend invitation email
 */

import { getServiceRoleClient, getAnonClient, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';
import { getOriginUrl } from '../_shared/origin.ts';
import { getEmailBaseUrl, getEmailFrom } from '../_shared/email.ts';

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * How long an invitation is good for.
 *
 * This number is not ours to choose freely. The link carries a GoTrue one-time token minted by
 * `generateLink`, and that token's lifetime is the project's Email OTP Expiration — which Supabase
 * caps at 24 hours. `invitations.expires_at` used to say 7 days, so the team page promised a week
 * for a link that was already dead. That gap is what stranded L&L's first invites: sent 7pm,
 * clicked the next morning, refused (#722). Keep the two in step — if the project setting ever
 * changes, change this with it.
 */
const INVITE_TTL_HOURS = 24;
const INVITE_TTL_MS = INVITE_TTL_HOURS * 60 * 60 * 1000;

/** Expiry for a freshly sent or resent invitation, as an ISO timestamp. */
function inviteExpiresAt(): string {
  return new Date(Date.now() + INVITE_TTL_MS).toISOString();
}

/**
 * Which invitations a resend may revive.
 *
 * `expired` belongs here and used to be refused. The list endpoint lazily flips a past-due
 * invitation to `expired`, so simply opening the team page disarmed the Resend button for the very
 * invitation whose holder was stuck — the admin-side half of the same dead-end. `accepted` and
 * `revoked` stay refused: those are decisions, not timeouts.
 */
const RESENDABLE_STATUSES = ['pending', 'expired'];

/**
 * Verify the caller is an admin of the specified company.
 * Uses an anon client with the user's JWT to extract user identity,
 * then uses the service role client for admin queries.
 * Returns the user_id if authorized, throws otherwise.
 */
async function verifyAdmin(
  supabase: ReturnType<typeof getServiceRoleClient>,
  authHeader: string,
  companyId: string
): Promise<string> {
  // Use anon client with user's JWT to get the authenticated user
  const anonClient = getAnonClient(authHeader);
  const { data: { user }, error } = await anonClient.auth.getUser();

  if (error || !user) {
    console.error('Auth verification failed:', error?.message);
    throw new Error('Not authenticated');
  }

  // Check admin role using service role client (bypasses RLS)
  const { data: access } = await supabase
    .from('user_company_access')
    .select('role')
    .eq('user_id', user.id)
    .eq('company_id', companyId)
    .in('role', ['admin'])
    .single();

  if (!access) {
    throw new Error('Not authorized — admin role required');
  }

  return user.id;
}

/**
 * Generate a one-time invitation token for a user via Supabase Auth.
 * Tries 'invite' type first (for new users), falls back to 'magiclink' (for existing users).
 * Returns the hashed token + its type, used to build a first-party
 * /auth/confirm link instead of the raw supabase.co action_link.
 */
async function generateInviteLink(
  supabase: ReturnType<typeof getServiceRoleClient>,
  email: string,
  redirectTo: string,
  metadata: Record<string, string>,
): Promise<{ hashedToken: string; type: 'invite' | 'magiclink' }> {
  // Try invite link first (creates user if they don't exist)
  const { data: inviteData, error: inviteError } = await supabase.auth.admin.generateLink({
    type: 'invite',
    email,
    options: {
      redirectTo,
      data: metadata,
    },
  });

  if (!inviteError && inviteData?.properties?.hashed_token) {
    return { hashedToken: inviteData.properties.hashed_token, type: 'invite' };
  }

  console.warn('generateLink(invite) failed, trying magiclink:', inviteError?.message);

  // Fallback: magic link for existing users
  const { data: magicData, error: magicError } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: {
      redirectTo,
    },
  });

  if (magicError || !magicData?.properties?.hashed_token) {
    console.error('generateLink(magiclink) also failed:', magicError);
    throw new Error('Failed to generate invitation link');
  }

  return { hashedToken: magicData.properties.hashed_token, type: 'magiclink' };
}

/**
 * Build the invitation email HTML.
 * Matches the design from supabase/templates/invite.html.
 */
function buildInviteEmailHtml(companyName: string, actionLink: string): string {
  const companyText = companyName
    ? `<strong style="color:#ffffff;">${companyName}</strong>`
    : 'a team';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <style>
    :root { color-scheme: light only; }
    [data-ogsc] body, .dark-mode body { background-color: #111439 !important; }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#111439; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#111439" style="background-color:#111439; padding:40px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" bgcolor="#1a1f4a" style="background-color:#1a1f4a; border:1px solid #2d3260; border-radius:8px; padding:40px;">
        <tr><td align="center" style="padding-bottom:24px;">
          <img src="${getEmailBaseUrl()}/jigged-logo.png" width="48" height="48" alt="Jigged">
        </td></tr>
        <tr><td align="center" style="color:#ffffff; font-size:20px; font-weight:600; padding-bottom:16px;">
          You've been invited to Jigged
        </td></tr>
        <tr><td align="center" style="color:#B0B3B8; font-size:14px; line-height:1.5; padding-bottom:24px;">
          You've been invited to join ${companyText} on Jigged. Click the button below to accept the invitation and set up your account.
        </td></tr>
        <tr><td align="center" style="padding-bottom:24px;">
          <a href="${actionLink}" style="display:inline-block; background-color:#4682B4; color:#ffffff; text-decoration:none; padding:14px 32px; border-radius:8px; font-size:16px; font-weight:500;">
            Accept Invitation
          </a>
        </td></tr>
        <tr><td align="center" style="color:#B0B3B8; font-size:12px; padding-bottom:12px;">
          This link works for ${INVITE_TTL_HOURS} hours. If it has expired, the page it opens will
          offer to send you a new one.
        </td></tr>
        <tr><td align="center" style="color:#B0B3B8; font-size:12px;">
          If you weren't expecting this invitation, you can safely ignore this email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Mint a fresh one-time link for an invitation and email it to the invitee.
 *
 * Shared by all three send paths — first send, admin resend, invitee-requested resend — so the
 * link shape, the metadata and the email body cannot drift apart between them.
 *
 * `redirectTo` is vestigial (Supabase no longer performs the redirect — our /auth/confirm route
 * does), but it is still passed so `generateLink`'s allow-list validation and the auth-callback
 * metadata fallback are unaffected.
 */
async function mintAndSendInvite(
  supabase: ReturnType<typeof getServiceRoleClient>,
  resendApiKey: string,
  invitation: { id: string; email: string; role: string },
  companyName: string,
  siteUrl: string,
): Promise<void> {
  const redirectTo = `${siteUrl}/accept-invite/${invitation.id}`;

  const { hashedToken, type } = await generateInviteLink(supabase, invitation.email, redirectTo, {
    invitation_id: invitation.id,
    company_name: companyName,
    invited_role: invitation.role,
  });

  const next = `/accept-invite/${invitation.id}`;
  const actionLink = `${getEmailBaseUrl()}/auth/confirm?token_hash=${encodeURIComponent(hashedToken)}&type=${type}&next=${encodeURIComponent(next)}`;

  await sendInviteEmail(resendApiKey, invitation.email, companyName, actionLink);
}

/**
 * Send an invitation email via Resend API.
 */
async function sendInviteEmail(
  apiKey: string,
  to: string,
  companyName: string,
  actionLink: string,
): Promise<void> {
  const html = buildInviteEmailHtml(companyName, actionLink);

  const from = getEmailFrom();

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `You've been invited to ${companyName || 'Jigged'}`,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
}

Deno.serve(async (req) => {
  // Handle CORS
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter(Boolean);
  // pathParts: ["team-invites"] or ["team-invites", ":id"] or ["team-invites", ":id", "resend"]

  try {
    const supabase = getServiceRoleClient();
    const authHeader = req.headers.get('Authorization') || '';

    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    if (!resendApiKey) {
      console.error('RESEND_API_KEY not configured');
      return errorResponse('Email service not configured', 500);
    }

    // POST /team-invites — Send invitation
    if (req.method === 'POST' && pathParts.length === 1) {
      const body = await req.json();
      const { company_id, email, role } = body;

      if (!company_id || !email || !role) {
        return errorResponse('company_id, email, and role are required', 400);
      }

      if (!['admin', 'user', 'operator'].includes(role)) {
        return errorResponse('role must be "admin", "user", or "operator"', 400);
      }

      // Basic email validation
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
        return errorResponse('Please enter a valid email address', 400);
      }

      const userId = await verifyAdmin(supabase, authHeader, company_id);

      // Block invitations to demo companies — users should only be invited to the main company.
      // Demo company access is automatically mirrored from the main company.
      const { data: targetCompany } = await supabase
        .from('companies')
        .select('is_demo')
        .eq('id', company_id)
        .single();

      if (targetCompany?.is_demo) {
        return errorResponse('Cannot send invitations to a demo company. Invite users to the main company instead — they will automatically get demo access.', 400);
      }

      // Check if user already has access to this company
      const { data: existingUsers } = await supabase.auth.admin.listUsers();
      const existingUser = existingUsers?.users?.find((u: { email?: string }) => u.email === email.toLowerCase());

      if (existingUser) {
        const { data: existingAccess } = await supabase
          .from('user_company_access')
          .select('id')
          .eq('user_id', existingUser.id)
          .eq('company_id', company_id)
          .single();

        if (existingAccess) {
          return errorResponse('This user already has access to this company', 400);
        }
      }

      // Check for existing pending invitation
      const { data: existingInvite } = await supabase
        .from('invitations')
        .select('id')
        .eq('email', email.toLowerCase())
        .eq('company_id', company_id)
        .eq('status', 'pending')
        .single();

      if (existingInvite) {
        await supabase
          .from('invitations')
          .update({ status: 'revoked' })
          .eq('id', existingInvite.id);
      }

      // Look up company name for context
      const { data: companyData } = await supabase
        .from('companies')
        .select('name')
        .eq('id', company_id)
        .single();

      const companyName = companyData?.name || '';

      // Create invitation record
      const { data: invitation, error: insertError } = await supabase
        .from('invitations')
        .insert({
          company_id,
          email: email.toLowerCase(),
          role,
          invited_by: userId,
          expires_at: inviteExpiresAt(),
        })
        .select()
        .single();

      if (insertError || !invitation) {
        console.error('Error creating invitation:', insertError);
        return errorResponse('Failed to create invitation', 500);
      }

      // Generate the one-time token and send a first-party email via Resend.
      try {
        await mintAndSendInvite(
          supabase,
          resendApiKey,
          { id: invitation.id, email: email.toLowerCase(), role },
          companyName,
          getOriginUrl(req),
        );
      } catch (emailErr) {
        console.error('Email sending error:', emailErr);
        // The invitation row exists, but the email never went out. Report this
        // honestly via email_sent:false so the UI can warn rather than show
        // a green "sent" confirmation the admin would trust.
        return jsonResponse({
          success: true,
          email_sent: false,
          invitation_id: invitation.id,
          message: `Invitation created, but the email could not be sent to ${email}. Use "Resend" on the team page to try again.`,
        });
      }

      return jsonResponse({
        success: true,
        email_sent: true,
        invitation_id: invitation.id,
        message: `Invitation sent to ${email}`,
      });
    }

    // GET /team-invites?company_id=xxx — List invitations
    if (req.method === 'GET' && pathParts.length === 1) {
      const companyId = url.searchParams.get('company_id');

      if (!companyId) {
        return errorResponse('company_id is required', 400);
      }

      await verifyAdmin(supabase, authHeader, companyId);

      // Lazily expire old invitations
      await supabase
        .from('invitations')
        .update({ status: 'expired' })
        .eq('company_id', companyId)
        .eq('status', 'pending')
        .lt('expires_at', new Date().toISOString());

      // Fetch all invitations
      const { data: invitations, error: fetchError } = await supabase
        .from('invitations')
        .select('id, company_id, email, role, status, invited_by, expires_at, created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false });

      if (fetchError) {
        console.error('Error fetching invitations:', fetchError);
        return errorResponse('Failed to fetch invitations', 500);
      }

      return jsonResponse(invitations || []);
    }

    // GET /team-invites/:id — Get single invitation (for accept-invite page)
    // No admin check — just returns the invitation. The accept-invite page
    // validates email match client-side. Uses service role to bypass RLS.
    if (req.method === 'GET' && pathParts.length === 2) {
      const invitationId = pathParts[1];

      const { data: invitation, error: fetchError } = await supabase
        .from('invitations')
        .select('id, company_id, email, role, status, invited_by, expires_at, created_at')
        .eq('id', invitationId)
        .single();

      if (fetchError || !invitation) {
        return errorResponse('Invitation not found', 404);
      }

      // Also fetch company name
      const { data: company } = await supabase
        .from('companies')
        .select('name')
        .eq('id', invitation.company_id)
        .single();

      return jsonResponse({ ...invitation, company_name: company?.name || '' });
    }

    // DELETE /team-invites/:id — Revoke invitation
    if (req.method === 'DELETE' && pathParts.length === 2) {
      const invitationId = pathParts[1];

      // Look up the invitation to get company_id for auth check
      const { data: invitation } = await supabase
        .from('invitations')
        .select('id, company_id, status')
        .eq('id', invitationId)
        .single();

      if (!invitation) {
        return errorResponse('Invitation not found', 404);
      }

      await verifyAdmin(supabase, authHeader, invitation.company_id);

      if (invitation.status !== 'pending') {
        return errorResponse('Only pending invitations can be revoked', 400);
      }

      const { error: updateError } = await supabase
        .from('invitations')
        .update({ status: 'revoked' })
        .eq('id', invitationId);

      if (updateError) {
        console.error('Error revoking invitation:', updateError);
        return errorResponse('Failed to revoke invitation', 500);
      }

      return jsonResponse({ success: true, message: 'Invitation revoked' });
    }

    // POST /team-invites/:id/resend — Resend invitation
    if (req.method === 'POST' && pathParts.length === 3 && pathParts[2] === 'resend') {
      const invitationId = pathParts[1];

      // Look up invitation
      const { data: invitation } = await supabase
        .from('invitations')
        .select('id, company_id, email, role, status, expires_at')
        .eq('id', invitationId)
        .single();

      if (!invitation) {
        return errorResponse('Invitation not found', 404);
      }

      await verifyAdmin(supabase, authHeader, invitation.company_id);

      if (!RESENDABLE_STATUSES.includes(invitation.status ?? '')) {
        return errorResponse(`An invitation that has been ${invitation.status} cannot be resent`, 400);
      }

      // Look up company name
      const { data: companyData } = await supabase
        .from('companies')
        .select('name')
        .eq('id', invitation.company_id)
        .single();

      const companyName = companyData?.name || '';

      // Reset expiry, and revive an invitation the lazy sweep had marked expired.
      await supabase
        .from('invitations')
        .update({ expires_at: inviteExpiresAt(), status: 'pending' })
        .eq('id', invitationId);

      try {
        await mintAndSendInvite(supabase, resendApiKey, invitation, companyName, getOriginUrl(req));
      } catch (emailErr) {
        console.error('Resend error:', emailErr);
        return errorResponse('Failed to resend invitation email', 500);
      }

      return jsonResponse({
        success: true,
        message: `Invitation resent to ${invitation.email}`,
      });
    }

    // POST /team-invites/:id/request-resend — invitee asks for a fresh link.
    //
    // Deliberately unauthenticated: the person who needs this is holding a dead link and has no
    // session — that is the whole failure being fixed (#722). Requiring auth would mean requiring
    // exactly the account they cannot yet reach, and routing them back through their admin.
    //
    // Safe without a caller identity because the caller supplies nothing that steers the email:
    // the destination is read from the invitation row, never from the request, so the only thing a
    // stranger with a stolen invitation UUID can do is mail the person who was already invited.
    // The 60-second guard below bounds how often.
    if (req.method === 'POST' && pathParts.length === 3 && pathParts[2] === 'request-resend') {
      const invitationId = pathParts[1];

      const { data: invitation } = await supabase
        .from('invitations')
        .select('id, company_id, email, role, status, expires_at')
        .eq('id', invitationId)
        .single();

      if (!invitation) {
        return errorResponse('Invitation not found', 404);
      }

      if (invitation.status === 'accepted') {
        return errorResponse('This invitation was already accepted — sign in instead.', 400);
      }

      if (!RESENDABLE_STATUSES.includes(invitation.status ?? '')) {
        return errorResponse(
          'This invitation is no longer valid. Ask your administrator to send a new one.',
          400,
        );
      }

      // Rate limit with the data we already have rather than a new column: every send pushes
      // expires_at to now + TTL, so an expiry still within a minute of its ceiling means a link
      // went out moments ago. Bounds this to one email a minute per invitation.
      const sentJustNow =
        new Date(invitation.expires_at).getTime() > Date.now() + INVITE_TTL_MS - 60_000;
      if (sentJustNow) {
        return errorResponse(
          'A new link was just sent. Check your inbox — and your spam folder.',
          429,
        );
      }

      const { data: companyData } = await supabase
        .from('companies')
        .select('name')
        .eq('id', invitation.company_id)
        .single();

      await supabase
        .from('invitations')
        .update({ expires_at: inviteExpiresAt(), status: 'pending' })
        .eq('id', invitationId);

      try {
        await mintAndSendInvite(
          supabase,
          resendApiKey,
          invitation,
          companyData?.name || '',
          getOriginUrl(req),
        );
      } catch (emailErr) {
        console.error('Requested resend error:', emailErr);
        return errorResponse('Could not send a new link. Please try again in a moment.', 500);
      }

      return jsonResponse({
        success: true,
        message: `A new link is on its way to ${invitation.email}.`,
      });
    }

    return errorResponse('Not found', 404);
  } catch (error) {
    if (error.message === 'Not authenticated') {
      return errorResponse('Not authenticated', 401);
    }
    if (error.message?.includes('Not authorized')) {
      return errorResponse(error.message, 403);
    }
    console.error('Team invites function error:', error);
    return errorResponse(`Internal server error: ${error.message}`, 500);
  }
});
