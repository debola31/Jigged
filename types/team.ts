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

/**
 * Unified row type for the team AG Grid tables.
 * Represents both active team members and pending invitations.
 */
export interface TeamRow {
  id: string;
  type: 'member' | 'invitation';
  name: string | null;
  email: string | null;
  role: 'admin' | 'user' | 'operator';
  status: 'active' | 'pending';
  created_at: string;
  last_sign_in_at?: string | null;
  expires_at?: string | null;
  invitation_id?: string;
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
  /**
   * Whether the invitation email was actually handed off to the provider (Resend).
   * `false` means the invitation record was created but the email send failed —
   * the admin must use "Resend" to try again. Absent on legacy responses.
   */
  email_sent?: boolean;
}
