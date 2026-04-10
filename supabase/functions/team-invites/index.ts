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

const RESEND_API_URL = 'https://api.resend.com/emails';

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
 * Allowed origin patterns for redirect links.
 * Prevents arbitrary URL injection while allowing all legitimate environments.
 */
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/.*\.jigged\.app$/,
  /^https:\/\/.*\.vercel\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

/**
 * Get the origin URL for redirect links from the request.
 * Reads the Origin (or Referer) header and validates against an allowlist.
 * Falls back to SITE_URL env var if no valid origin is present.
 */
function getOriginUrl(req: Request): string {
  const origin = req.headers.get('origin') || req.headers.get('referer');
  if (origin) {
    try {
      const parsed = new URL(origin);
      const originBase = parsed.origin;
      if (ALLOWED_ORIGIN_PATTERNS.some(p => p.test(originBase))) {
        return originBase;
      }
    } catch {
      // Invalid URL — fall through to default
    }
  }
  return Deno.env.get('SITE_URL') || Deno.env.get('NEXT_PUBLIC_APP_URL') || 'http://localhost:3000';
}

/**
 * Generate an invitation link for a user via Supabase Auth.
 * Tries 'invite' type first (for new users), falls back to 'magiclink' (for existing users).
 * Returns the action_link URL that the user should click.
 */
async function generateInviteLink(
  supabase: ReturnType<typeof getServiceRoleClient>,
  email: string,
  redirectTo: string,
  metadata: Record<string, string>,
): Promise<string> {
  // Try invite link first (creates user if they don't exist)
  const { data: inviteData, error: inviteError } = await supabase.auth.admin.generateLink({
    type: 'invite',
    email,
    options: {
      redirectTo,
      data: metadata,
    },
  });

  if (!inviteError && inviteData?.properties?.action_link) {
    return inviteData.properties.action_link;
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

  if (magicError || !magicData?.properties?.action_link) {
    console.error('generateLink(magiclink) also failed:', magicError);
    throw new Error('Failed to generate invitation link');
  }

  return magicData.properties.action_link;
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
          <svg viewBox="0 0 64 64" width="48" height="48" xmlns="http://www.w3.org/2000/svg">
            <rect width="64" height="64" rx="12" fill="#151520"/>
            <rect x="14" y="10" width="30" height="10" rx="2" fill="#D4872A"/>
            <rect x="30" y="10" width="10" height="32" fill="#4682B4"/>
            <path d="M40 42 L40 54 L26 54 Q14 54 14 42 L24 42 Q30 42 30 48 L30 54" fill="#2BBCB3"/>
          </svg>
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
 * Send an invitation email via Resend API.
 */
async function sendInviteEmail(
  apiKey: string,
  to: string,
  companyName: string,
  actionLink: string,
): Promise<void> {
  const html = buildInviteEmailHtml(companyName, actionLink);

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: 'Jigged <noreply@jigged.app>',
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
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const { data: invitation, error: insertError } = await supabase
        .from('invitations')
        .insert({
          company_id,
          email: email.toLowerCase(),
          role,
          invited_by: userId,
          expires_at: expiresAt.toISOString(),
        })
        .select()
        .single();

      if (insertError || !invitation) {
        console.error('Error creating invitation:', insertError);
        return errorResponse('Failed to create invitation', 500);
      }

      // Generate invitation link and send email via Resend
      const siteUrl = getOriginUrl(req);
      const redirectTo = `${siteUrl}/accept-invite/${invitation.id}`;

      try {
        const actionLink = await generateInviteLink(supabase, email.toLowerCase(), redirectTo, {
          invitation_id: invitation.id,
          company_name: companyName,
          invited_role: role,
        });

        await sendInviteEmail(resendApiKey, email.toLowerCase(), companyName, actionLink);
      } catch (emailErr) {
        console.error('Email sending error:', emailErr);
        return jsonResponse({
          success: true,
          invitation_id: invitation.id,
          message: `Invitation created but email could not be sent. Use "Resend" to try again.`,
        });
      }

      return jsonResponse({
        success: true,
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

      if (invitation.status !== 'pending') {
        return errorResponse('Only pending invitations can be resent', 400);
      }

      // Look up company name
      const { data: companyData } = await supabase
        .from('companies')
        .select('name')
        .eq('id', invitation.company_id)
        .single();

      const companyName = companyData?.name || '';

      // Reset expiry
      const newExpiresAt = new Date();
      newExpiresAt.setDate(newExpiresAt.getDate() + 7);

      await supabase
        .from('invitations')
        .update({ expires_at: newExpiresAt.toISOString() })
        .eq('id', invitationId);

      // Generate link and resend via Resend
      const siteUrl = getOriginUrl(req);
      const redirectTo = `${siteUrl}/accept-invite/${invitation.id}`;

      try {
        const actionLink = await generateInviteLink(supabase, invitation.email, redirectTo, {
          invitation_id: invitation.id,
          company_name: companyName,
          invited_role: invitation.role,
        });

        await sendInviteEmail(resendApiKey, invitation.email, companyName, actionLink);
      } catch (emailErr) {
        console.error('Resend error:', emailErr);
        return errorResponse('Failed to resend invitation email', 500);
      }

      return jsonResponse({
        success: true,
        message: `Invitation resent to ${invitation.email}`,
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
