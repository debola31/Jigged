/**
 * Team member types for all roles (admin, user, operator).
 * All roles use the same unified structure.
 */

export interface TeamMember {
  id: string;
  user_id: string;
  company_id: string;
  role: 'admin' | 'user' | 'operator';
  name: string | null;
  email: string | null;
  last_sign_in_at: string | null;
  created_at: string;
}

/**
 * Invitation types for magic link team member invitations.
 */

export interface Invitation {
  id: string;
  company_id: string;
  email: string;
  role: 'admin' | 'user' | 'operator';
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invited_by: string;
  expires_at: string;
  created_at: string;
}

export interface InviteRequest {
  company_id: string;
  email: string;
  role: 'admin' | 'user' | 'operator';
}

export interface InviteResponse {
  success: boolean;
  invitation_id: string;
  message: string;
}
