'use client';

import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Session, User, AuthChangeEvent } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';
import { redirectToSessionExpiry } from '@/lib/supabaseErrors';
import { clearStoredStation } from '@/lib/operatorStationStorage';

/**
 * Sign-out scope. `local` (default) ends only this device's session; `others`
 * ends every OTHER session but keeps this one; `global` ends them all. Ordinary
 * logout is `local` so one device signing out never revokes an operator's
 * session on their other devices (which showed up as a forced re-login on the
 * shop floor). The password-reset flow opts into `global` explicitly.
 */
type SignOutScope = 'local' | 'global' | 'others';

interface AuthContextType {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: (scope?: SignOutScope) => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  session: null,
  user: null,
  loading: true,
  signOut: async () => {},
});

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

interface AuthProviderProps {
  children: React.ReactNode;
}

export default function AuthProvider({ children }: AuthProviderProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const intentionalSignOut = useRef(false);
  const hadSession = useRef(false);

  useEffect(() => {
    const supabase = getSupabase();

    // Get initial session
    const getInitialSession = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        setSession(data.session);
        setUser(data.session?.user ?? null);
        if (data.session) {
          hadSession.current = true;
        }
      } catch (error) {
        console.error('Failed to get initial session:', error);
        Sentry.captureException(error);
      } finally {
        setLoading(false);
      }
    };

    getInitialSession();

    // Listen for auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (event: AuthChangeEvent, newSession: Session | null) => {
        setSession(newSession);
        setUser(newSession?.user ?? null);
        setLoading(false);

        if (newSession) {
          hadSession.current = true;
        }

        // Detect unexpected session loss (token refresh failure).
        // Store expiry info in sessionStorage so AuthGuard can include
        // it in its redirect to /login.
        if (event === 'SIGNED_OUT' && !intentionalSignOut.current && hadSession.current) {
          hadSession.current = false;
          redirectToSessionExpiry();
        }

        if (event === 'SIGNED_OUT') {
          intentionalSignOut.current = false;
          posthog.capture('user_signed_out');
          posthog.reset();
        }
      }
    );

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Set Sentry user context and identify with PostHog for error tracking and analytics
  useEffect(() => {
    if (user) {
      Sentry.setUser({ id: user.id, email: user.email ?? undefined });
      posthog.identify(user.id, { email: user.email ?? undefined });
    } else {
      Sentry.setUser(null);
    }
  }, [user]);

  const signOut = async (scope: SignOutScope = 'local') => {
    intentionalSignOut.current = true;
    const supabase = getSupabase();
    // Default `local` — revokes ONLY this device's session, so logging out on
    // one device leaves the user signed in everywhere else. Callers that need
    // to invalidate other devices pass an explicit scope: the password-reset
    // flow (ResetPassword) passes 'global' to kill lost/old devices, and the
    // change-password flow calls supabase.auth.signOut({ scope: 'others' })
    // directly. Do NOT change this default without revisiting those two flows.
    //
    // Forget the selected station for EVERY company on the way out. It is
    // device-local, not account-local, so Supabase's own sign-out does not touch
    // it: without this, the next person to sign in on a shared shop phone
    // inherits whatever machine the last person was standing at, and their notes
    // get filed against it with nothing on screen to say so. Skipped for
    // `others` on purpose — that scope deliberately keeps THIS device signed in,
    // so there is no handover and no reason to strip a working station.
    if (scope !== 'others') clearStoredStation();
    await supabase.auth.signOut({ scope });
  };

  return (
    <AuthContext.Provider value={{ session, user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
