/**
 * Unified Team Edge Function
 *
 * Handles team member operations for all roles (admin, user, operator).
 * All roles follow the same pattern: auth.users + user_company_access
 *
 * Endpoints:
 * - GET /team?company_id=xxx              - List all team members
 * - GET /team?company_id=xxx&role=xxx     - Filter by role
 * - GET /team/:id                         - Get single member
 * - PATCH /team/:id                       - Update member (name, role)
 * - POST /team/:id/reset-password         - Email a single-use recovery link
 *
 * Note: Team member creation is now handled via magic link invitations
 * in the team-invites Edge Function. The old POST /team endpoint has been removed.
 */ import { getServiceRoleClient, getAnonClient, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';
import { getOriginUrl } from '../_shared/origin.ts';
import { writeAuthAudit } from '../_shared/auth-audit.ts';

const RESEND_API_URL = 'https://api.resend.com/emails';
const RECOVERY_EVENT = 'admin_password_recovery';

// Generic 200 returned for every branch of the reset-password handler that
// touches user-specific state. Distinct outcomes go to the audit log only,
// not the wire — preventing account-existence enumeration.
const RECOVERY_GENERIC_BODY = {
  success: true,
  message: 'If that user has an account, a reset link has been sent.'
};

function recoveryGenericResponse() {
  return jsonResponse(RECOVERY_GENERIC_BODY);
}

/**
 * Build the recovery email HTML. Mirrors the dark-themed Jigged style used
 * by team-invites, but with copy specific to admin-triggered password reset:
 * - names the company so users in multiple shops can identify the workspace
 * - states expiry in plain text
 * - tells the user what to do if unexpected
 *
 * companyName MUST already be falsy-checked by the caller — if companies.name
 * is ever null/empty we still want the email to read sensibly.
 */
function buildRecoveryEmailHtml(companyName: string, actionLink: string): string {
  const sentenceLeadin = companyName
    ? `An administrator at <strong style="color:#ffffff;">${companyName}</strong> reset your Jigged password.`
    : `An administrator at your Jigged workspace reset your password.`;

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
          Reset your Jigged password
        </td></tr>
        <tr><td style="color:#B0B3B8; font-size:14px; line-height:1.5; padding-bottom:20px;">
          ${sentenceLeadin} Click the button below to set a new password.
        </td></tr>
        <tr><td style="color:#B0B3B8; font-size:14px; line-height:1.5; padding-bottom:24px;">
          This link expires in 1 hour and can only be used once.
        </td></tr>
        <tr><td align="center" style="padding-bottom:24px;">
          <a href="${actionLink}" style="display:inline-block; background-color:#4682B4; color:#ffffff; text-decoration:none; padding:14px 32px; border-radius:8px; font-size:16px; font-weight:500;">
            Set a new password
          </a>
        </td></tr>
        <tr><td style="color:#7A7D8A; font-size:12px; line-height:1.5; padding-bottom:16px; word-break:break-all;">
          If the button doesn't work, copy and paste this link into your browser:<br>
          <a href="${actionLink}" style="color:#7A7D8A;">${actionLink}</a>
        </td></tr>
        <tr><td style="color:#B0B3B8; font-size:12px; line-height:1.5;">
          If you weren't expecting this, you can safely ignore this email — your password won't change unless you click the link. If you're concerned, contact your administrator.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendRecoveryEmail(
  apiKey: string,
  to: string,
  companyName: string,
  actionLink: string,
): Promise<void> {
  const html = buildRecoveryEmailHtml(companyName, actionLink);

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: 'Jigged <noreply@jigged.app>',
      to: [to],
      subject: 'Reset your Jigged password',
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
}

Deno.serve(async (req)=>{
  // Handle CORS
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter(Boolean);
  // Path: /team or /team/:id or /team/:id/reset-password
  try {
    const supabase = getServiceRoleClient();
    // GET /team?company_id=xxx&role=xxx - List team members
    if (req.method === 'GET' && pathParts.length === 1) {
      const companyId = url.searchParams.get('company_id');
      const role = url.searchParams.get('role');
      if (!companyId) {
        return errorResponse('company_id is required', 400);
      }
      // Build query
      let query = supabase.from('user_company_access').select('id, user_id, company_id, role, name, created_at').eq('company_id', companyId);
      // Filter by role if specified
      if (role && [
        'admin',
        'user',
        'operator'
      ].includes(role)) {
        query = query.eq('role', role);
      }
      const { data: accessRecords, error: accessError } = await query.order('name');
      if (accessError) {
        console.error('Error fetching team members:', accessError);
        return errorResponse('Failed to fetch team members', 500);
      }
      if (!accessRecords || accessRecords.length === 0) {
        return jsonResponse([]);
      }
      // Exclude system admins from the team list
      const { data: sysAdmins } = await supabase.from('system_admins').select('user_id');
      const systemAdminIds = new Set(sysAdmins?.map((sa: { user_id: string }) => sa.user_id) || []);
      const filteredRecords = accessRecords.filter((r: { user_id: string }) => !systemAdminIds.has(r.user_id));
      if (filteredRecords.length === 0) {
        return jsonResponse([]);
      }
      // Build user info map from auth.users (for email and last_sign_in_at)
      const userIds = filteredRecords.map((r)=>r.user_id).filter(Boolean);
      const userMap = {};
      if (userIds.length > 0) {
        const { data: users, error: usersError } = await supabase.auth.admin.listUsers();
        if (!usersError && users?.users) {
          for (const user of users.users){
            if (userIds.includes(user.id)) {
              userMap[user.id] = {
                email: user.email || null,
                last_sign_in_at: user.last_sign_in_at || null
              };
            }
          }
        }
      }
      // Combine data
      const result = filteredRecords.map((record)=>({
          id: record.id,
          user_id: record.user_id,
          company_id: record.company_id,
          role: record.role,
          name: record.name,
          email: userMap[record.user_id]?.email || null,
          last_sign_in_at: userMap[record.user_id]?.last_sign_in_at || null,
          created_at: record.created_at
        }));
      return jsonResponse(result);
    }
    // GET /team/:id - Get single team member
    if (req.method === 'GET' && pathParts.length === 2) {
      const memberId = pathParts[1];
      const { data: record, error: recordError } = await supabase.from('user_company_access').select('id, user_id, company_id, role, name, created_at').eq('id', memberId).single();
      if (recordError || !record) {
        return errorResponse('Team member not found', 404);
      }
      // Get user info
      let email = null;
      let last_sign_in_at = null;
      if (record.user_id) {
        const { data: userData } = await supabase.auth.admin.getUserById(record.user_id);
        email = userData?.user?.email || null;
        last_sign_in_at = userData?.user?.last_sign_in_at || null;
      }
      return jsonResponse({
        id: record.id,
        user_id: record.user_id,
        company_id: record.company_id,
        role: record.role,
        name: record.name,
        email,
        last_sign_in_at,
        created_at: record.created_at
      });
    }
    // POST /team — removed (team member creation now uses magic link invitations via team-invites Edge Function)
    // PATCH /team/:id - Update team member (name, role)
    if (req.method === 'PATCH' && pathParts.length === 2) {
      const memberId = pathParts[1];
      const body = await req.json();
      const { name, role } = body;
      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (role !== undefined) {
        if (![
          'admin',
          'user',
          'operator'
        ].includes(role)) {
          return errorResponse('role must be "admin", "user", or "operator"', 400);
        }
        updateData.role = role;
      }
      if (Object.keys(updateData).length === 0) {
        return errorResponse('No fields to update', 400);
      }
      const { data: updated, error: updateError } = await supabase.from('user_company_access').update(updateData).eq('id', memberId).select().single();
      if (updateError) {
        console.error('Error updating team member:', updateError);
        return errorResponse('Failed to update team member', 500);
      }
      return jsonResponse({
        success: true,
        id: updated.id,
        message: 'Team member updated successfully'
      });
    }
    // POST /team/:id/reset-password
    //
    // Admin-triggered, email-link password reset. The admin never sees,
    // sets, or transmits a password — Supabase mints a single-use,
    // expiring recovery token and we send it via Resend to the target's
    // verified email.
    //
    // Security model (see plans/we-need-to-replace-atomic-wirth.md):
    //   1. JWT must be present (401 if not — no enumeration vector here).
    //   2. Defense-in-depth admin check: the target row is fetched via
    //      an anon client carrying the caller's JWT. RLS on
    //      user_company_access restricts SELECT to is_company_admin, so
    //      a non-admin gets back nothing — even if step 3's service-role
    //      check were ever bypassed.
    //   3. Belt-and-braces explicit role check via service role.
    //   4. Every subsequent branch returns the same generic 200 body to
    //      prevent account-existence enumeration; outcomes are
    //      distinguished only in the audit log.
    if (req.method === 'POST' && pathParts.length === 3 && pathParts[2] === 'reset-password') {
      const memberId = pathParts[1];

      // 1. JWT verify — return 401, NOT generic. Nothing to enumerate
      //    without a session, and a 200 here would flood the audit log
      //    with anonymous scanner noise.
      const authHeader = req.headers.get('Authorization') || '';
      const anon = getAnonClient(authHeader);
      const { data: authData, error: jwtErr } = await anon.auth.getUser();
      const actor = authData?.user;
      if (jwtErr || !actor) {
        return errorResponse('Not authenticated', 401);
      }

      // 2. Defense-in-depth: RLS-bound SELECT on user_company_access.
      //    is_company_admin(company_id) restricts this row to actors who
      //    are admins of the target's company. Non-admins get nothing.
      const { data: target } = await anon
        .from('user_company_access')
        .select('user_id, company_id, role')
        .eq('id', memberId)
        .maybeSingle();

      if (!target) {
        // ENUMERATION-PROTECTED. Could be: row doesn't exist, RLS
        // blocked because caller isn't admin of that company, or the
        // member has no user_company_access row. Single generic
        // response either way.
        await writeAuthAudit(supabase, {
          actor_user_id: actor.id,
          event_type: RECOVERY_EVENT,
          outcome: 'forbidden',
          error_detail: 'rls_blocked_or_not_found',
        });
        return recoveryGenericResponse();
      }

      // 3. Belt-and-braces: explicit role check via service role. Survives
      //    even if the user_company_access RLS is ever loosened.
      const { data: actorAccess } = await supabase
        .from('user_company_access')
        .select('role')
        .eq('user_id', actor.id)
        .eq('company_id', target.company_id)
        .maybeSingle();

      if (actorAccess?.role !== 'admin') {
        // ENUMERATION-PROTECTED.
        await writeAuthAudit(supabase, {
          actor_user_id: actor.id,
          target_user_id: target.user_id,
          company_id: target.company_id,
          event_type: RECOVERY_EVENT,
          outcome: 'forbidden',
          error_detail: 'not_admin',
        });
        return recoveryGenericResponse();
      }

      // 4. Resolve target email. Defense-in-depth: every auth.users row
      //    from the invite flow has an email, so this branch is mostly
      //    unreachable — operator accounts may lack emails but are out
      //    of scope for this admin-recovery flow. Keep the guard so we
      //    never call generateLink with an undefined email.
      if (!target.user_id) {
        console.error('admin_password_recovery: target has no user_id', {
          target_member_id: memberId,
          company_id: target.company_id,
        });
        await writeAuthAudit(supabase, {
          actor_user_id: actor.id,
          target_user_id: null,
          company_id: target.company_id,
          event_type: RECOVERY_EVENT,
          outcome: 'failed',
          error_detail: 'target_has_no_user_id',
        });
        return recoveryGenericResponse();
      }

      const { data: targetUser } = await supabase.auth.admin.getUserById(target.user_id);
      const email = targetUser?.user?.email;
      if (!email) {
        console.error('admin_password_recovery: target user has no email', {
          target_user_id: target.user_id,
          company_id: target.company_id,
        });
        await writeAuthAudit(supabase, {
          actor_user_id: actor.id,
          target_user_id: target.user_id,
          company_id: target.company_id,
          event_type: RECOVERY_EVENT,
          outcome: 'failed',
          error_detail: 'no_email',
        });
        return recoveryGenericResponse();
      }

      // 5. Mint the recovery link. Origin comes from the allowlist-vetted
      //    helper — NEVER from a raw header — to defend against OWASP
      //    Host header injection on password reset.
      const resendApiKey = Deno.env.get('RESEND_API_KEY');
      if (!resendApiKey) {
        console.error('admin_password_recovery: RESEND_API_KEY not configured');
        await writeAuthAudit(supabase, {
          actor_user_id: actor.id,
          target_user_id: target.user_id,
          company_id: target.company_id,
          event_type: RECOVERY_EVENT,
          outcome: 'failed',
          error_detail: 'resend_not_configured',
        });
        return recoveryGenericResponse();
      }

      const siteUrl = getOriginUrl(req);
      // Land directly on /reset-password. Recovery sessions are
      // delivered either as a `?code=...` (PKCE) or in the URL hash
      // (implicit). The server-side /auth/callback route only handles
      // the query-param form — sending users through it for recovery
      // breaks the hash flow (the hash is preserved through the
      // redirect but the destination doesn't know what to do with it).
      // The /reset-password page handles both shapes directly.
      const redirectTo = `${siteUrl}/reset-password`;

      const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo },
      });

      if (linkErr || !linkData?.properties?.action_link) {
        console.error('admin_password_recovery: generateLink failed', linkErr);
        await writeAuthAudit(supabase, {
          actor_user_id: actor.id,
          target_user_id: target.user_id,
          company_id: target.company_id,
          event_type: RECOVERY_EVENT,
          outcome: 'failed',
          error_detail: `generate_link: ${linkErr?.message || 'no_action_link'}`,
        });
        return recoveryGenericResponse();
      }

      // 6. Look up company name for the email body. companies.name is
      //    NOT NULL in the schema (defense-in-depth fallback only).
      const { data: companyData } = await supabase
        .from('companies')
        .select('name')
        .eq('id', target.company_id)
        .single();

      const rawName = companyData?.name?.trim();
      const companyName = rawName && rawName.length > 0 ? rawName : '';

      // 7. Send via Resend.
      try {
        await sendRecoveryEmail(resendApiKey, email, companyName, linkData.properties.action_link);
      } catch (emailErr) {
        console.error('admin_password_recovery: Resend failed', emailErr);
        await writeAuthAudit(supabase, {
          actor_user_id: actor.id,
          target_user_id: target.user_id,
          company_id: target.company_id,
          event_type: RECOVERY_EVENT,
          outcome: 'failed',
          error_detail: `resend: ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`,
        });
        return recoveryGenericResponse();
      }

      // 8. Success.
      // TODO: rate-limit per (actor, target) pair — currently nothing
      // prevents spam-resetting. Not catastrophic (no compromise vector,
      // just email noise) but worth a follow-up.
      await writeAuthAudit(supabase, {
        actor_user_id: actor.id,
        target_user_id: target.user_id,
        company_id: target.company_id,
        event_type: RECOVERY_EVENT,
        outcome: 'success',
      });
      return recoveryGenericResponse();
    }
    return errorResponse('Not found', 404);
  } catch (error) {
    console.error('Team function error:', error);
    return errorResponse(`Internal server error: ${error.message}`, 500);
  }
});
