'use client';

import * as Sentry from "@sentry/nextjs";
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Session, User, AuthChangeEvent } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';
import { redirectToSessionExpiry } from '@/lib/supabaseErrors';

interface AuthContextType {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
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
        }
      }
    );

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  // Set Sentry user context for error tracking
  useEffect(() => {
    if (user) {
      Sentry.setUser({ id: user.id, email: user.email ?? undefined });
    } else {
      Sentry.setUser(null);
    }
  }, [user]);

  const signOut = async () => {
    intentionalSignOut.current = true;
    const supabase = getSupabase();
    // Explicit scope='global' — revokes every session for this user
    // across all devices. The ResetPassword flow relies on this to
    // invalidate the lost/old device after an admin-triggered reset.
    // Do NOT narrow this scope without also updating the password-reset
    // flow's session-invalidation guarantee.
    await supabase.auth.signOut({ scope: 'global' });
  };

  return (
    <AuthContext.Provider value={{ session, user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
