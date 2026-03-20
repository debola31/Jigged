/**
 * Team Invitations Edge Function
 *
 * Handles magic link invitations for team members.
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
 * Send an invitation email via Resend for existing users
 * (where Supabase's inviteUserByEmail fails).
 */
async function sendInviteEmailViaResend(
  { to, actionLink, companyName, role }: { to: string; actionLink: string; companyName: string; role: string },
): Promise<void> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) {
    throw new Error('RESEND_API_KEY not configured');
  }

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: 'Jigged <noreply@jigged.app>',
      to: [to],
      subject: `You've been invited to join ${companyName || 'a team'} on Jigged`,
      html: `
        <h2>You've been invited to join ${companyName || 'a team'} on Jigged</h2>
        <p>You've been invited as <strong>${role}</strong>.</p>
        <p>Click the link below to accept the invitation:</p>
        <p><a href="${actionLink}" style="display:inline-block;padding:12px 24px;background:#1976d2;color:#fff;text-decoration:none;border-radius:6px;">Accept Invitation</a></p>
        <p>Or copy and paste this URL into your browser:</p>
        <p>${actionLink}</p>
        <p>This link will expire in 7 days.</p>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
}

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

      // Send magic link via Supabase inviteUserByEmail
      const siteUrl = getOriginUrl(req);
      const redirectTo = `${siteUrl}/auth/callback?next=/accept-invite/${invitation.id}`;

      try {
        const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email.toLowerCase(), {
          redirectTo,
          data: {
            invitation_id: invitation.id,
            company_name: companyName,
            invited_role: role,
          },
        });

        if (inviteError) {
          console.warn('inviteUserByEmail failed:', inviteError.message);

          // Check if this is a ghost user (exists in Auth but has no company access anywhere)
          if (existingUser) {
            const { data: anyAccess } = await supabase
              .from('user_company_access')
              .select('id')
              .eq('user_id', existingUser.id)
              .limit(1)
              .single();

            if (!anyAccess) {
              // Ghost user from a previous failed invite — delete and re-invite
              console.log('Deleting ghost user and re-inviting:', email.toLowerCase());
              await supabase.auth.admin.deleteUser(existingUser.id);

              const { error: retryError } = await supabase.auth.admin.inviteUserByEmail(email.toLowerCase(), {
                redirectTo,
                data: {
                  invitation_id: invitation.id,
                  company_name: companyName,
                  invited_role: role,
                },
              });

              if (retryError) {
                console.error('Re-invite after delete also failed:', retryError);
                return jsonResponse({
                  success: true,
                  invitation_id: invitation.id,
                  message: `Invitation created but email could not be sent. Use "Resend" to try again.`,
                });
              }
            } else {
              // Active user in another company — send magic link via Resend
              const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
                type: 'magiclink',
                email: email.toLowerCase(),
                options: { redirectTo },
              });

              if (linkError) {
                console.error('generateLink failed:', linkError);
                return jsonResponse({
                  success: true,
                  invitation_id: invitation.id,
                  message: `Invitation created but email could not be sent. Use "Resend" to try again.`,
                });
              }

              try {
                await sendInviteEmailViaResend({
                  to: email.toLowerCase(),
                  actionLink: linkData.properties.action_link,
                  companyName,
                  role,
                });
              } catch (emailErr) {
                console.error('Resend email failed:', emailErr);
                return jsonResponse({
                  success: true,
                  invitation_id: invitation.id,
                  message: `Invitation created but email could not be sent. Use "Resend" to try again.`,
                });
              }
            }
          }
        }
      } catch (emailErr) {
        console.error('Email sending error:', emailErr);
        // Invitation record exists — admin can resend
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

      // Resend magic link
      const siteUrl = getOriginUrl(req);
      const redirectTo = `${siteUrl}/auth/callback?next=/accept-invite/${invitation.id}`;

      try {
        const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(invitation.email, {
          redirectTo,
          data: {
            invitation_id: invitation.id,
            company_name: companyName,
            invited_role: invitation.role,
          },
        });

        if (inviteError) {
          console.warn('inviteUserByEmail failed on resend:', inviteError.message);

          // Look up existing user to determine the right fallback
          const { data: existingUsers } = await supabase.auth.admin.listUsers();
          const existingUser = existingUsers?.users?.find(
            (u: { email?: string }) => u.email === invitation.email.toLowerCase()
          );

          if (existingUser) {
            const { data: anyAccess } = await supabase
              .from('user_company_access')
              .select('id')
              .eq('user_id', existingUser.id)
              .limit(1)
              .single();

            if (!anyAccess) {
              // Ghost user — delete and re-invite
              await supabase.auth.admin.deleteUser(existingUser.id);
              const { error: retryError } = await supabase.auth.admin.inviteUserByEmail(invitation.email, {
                redirectTo,
                data: {
                  invitation_id: invitation.id,
                  company_name: companyName,
                  invited_role: invitation.role,
                },
              });
              if (retryError) {
                return errorResponse('Failed to resend invitation email', 500);
              }
            } else {
              // Active user — send magic link via Resend
              const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
                type: 'magiclink',
                email: invitation.email,
                options: { redirectTo },
              });

              if (linkError) {
                return errorResponse('Failed to resend invitation email', 500);
              }

              try {
                await sendInviteEmailViaResend({
                  to: invitation.email,
                  actionLink: linkData.properties.action_link,
                  companyName,
                  role: invitation.role,
                });
              } catch (emailErr) {
                console.error('Resend email failed:', emailErr);
                return errorResponse('Failed to resend invitation email', 500);
              }
            }
          } else {
            return errorResponse('Failed to resend invitation email', 500);
          }
        }
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
