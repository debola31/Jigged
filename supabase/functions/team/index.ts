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
 * - POST /team/:id/reset-password         - Reset password
 *
 * Note: Team member creation is now handled via magic link invitations
 * in the team-invites Edge Function. The old POST /team endpoint has been removed.
 */ import { getServiceRoleClient, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';
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
      // Build user info map from auth.users (for email and last_sign_in_at)
      const userIds = accessRecords.map((r)=>r.user_id).filter(Boolean);
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
      const result = accessRecords.map((record)=>({
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
    if (req.method === 'POST' && pathParts.length === 3 && pathParts[2] === 'reset-password') {
      const memberId = pathParts[1];
      const body = await req.json();
      const { new_password } = body;
      if (!new_password || new_password.length < 8) {
        return errorResponse('new_password must be at least 8 characters', 400);
      }
      // Get access record to find user_id
      const { data: record, error: recordError } = await supabase.from('user_company_access').select('user_id, name').eq('id', memberId).single();
      if (recordError || !record) {
        return errorResponse('Team member not found', 404);
      }
      if (!record.user_id) {
        return errorResponse('Team member has no linked user account', 400);
      }
      // Update password
      const { error: updateError } = await supabase.auth.admin.updateUserById(record.user_id, {
        password: new_password,
        user_metadata: {
          needs_password_change: true
        }
      });
      if (updateError) {
        console.error('Error resetting password:', updateError);
        return errorResponse('Failed to reset password', 500);
      }
      return jsonResponse({
        success: true,
        message: `Password reset for ${record.name || 'team member'}. They will be required to change it on next login.`
      });
    }
    return errorResponse('Not found', 404);
  } catch (error) {
    console.error('Team function error:', error);
    return errorResponse(`Internal server error: ${error.message}`, 500);
  }
});
