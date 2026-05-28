import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../../test-utils';
import userEvent from '@testing-library/user-event';
import SignUp from '@/components/auth/SignUp';

const sharedSupabase = {
  auth: {
    signUp: vi.fn(),
  },
};

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => sharedSupabase,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

describe('SignUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sharedSupabase.auth.signUp.mockResolvedValue({ data: { user: { id: 'u-1' } }, error: null });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL('http://localhost:3000/signup'),
    });
  });

  async function fillForm(opts: {
    firstName?: string;
    lastName?: string;
    email?: string;
    password?: string;
    confirm?: string;
  } = {}) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/first name/i), opts.firstName ?? 'Ada');
    await user.type(screen.getByLabelText(/last name/i), opts.lastName ?? 'Lovelace');
    await user.type(screen.getByLabelText(/email/i), opts.email ?? 'ada@example.com');
    await user.type(screen.getByLabelText(/^password/i), opts.password ?? 'hunter22');
    await user.type(
      screen.getByLabelText(/confirm password/i),
      opts.confirm ?? opts.password ?? 'hunter22',
    );
    await user.click(screen.getByRole('button', { name: /create account/i }));
  }

  it('renders the create-account form', () => {
    render(<SignUp />);
    expect(screen.getByRole('heading', { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/first name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
  });

  it('rejects empty first/last names', async () => {
    const user = userEvent.setup();
    render(<SignUp />);
    // Skip names; HTML `required` would normally block submit, but the
    // component re-validates trimmed values too. Bypass HTML required by
    // typing whitespace.
    await user.type(screen.getByLabelText(/first name/i), '   ');
    await user.type(screen.getByLabelText(/last name/i), '   ');
    await user.type(screen.getByLabelText(/email/i), 'a@b.co');
    await user.type(screen.getByLabelText(/^password/i), 'hunter22');
    await user.type(screen.getByLabelText(/confirm password/i), 'hunter22');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(
      await screen.findByText(/first name and last name are required/i),
    ).toBeInTheDocument();
    expect(sharedSupabase.auth.signUp).not.toHaveBeenCalled();
  });

  it('rejects mismatched passwords', async () => {
    render(<SignUp />);
    await fillForm({ password: 'hunter22', confirm: 'hunter23' });

    // The confirm-password field also shows an inline "Passwords do not match"
    // hint while typing, so match the Alert role specifically.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/passwords do not match/i);
    expect(sharedSupabase.auth.signUp).not.toHaveBeenCalled();
  });

  it('rejects passwords shorter than 6 characters', async () => {
    render(<SignUp />);
    await fillForm({ password: 'pw1', confirm: 'pw1' });

    expect(
      await screen.findByText(/password must be at least 6 characters/i),
    ).toBeInTheDocument();
    expect(sharedSupabase.auth.signUp).not.toHaveBeenCalled();
  });

  it('calls signUp with metadata on valid submit', async () => {
    render(<SignUp />);
    await fillForm({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      password: 'analytical-engine',
    });

    await waitFor(() => {
      expect(sharedSupabase.auth.signUp).toHaveBeenCalledWith({
        email: 'ada@example.com',
        password: 'analytical-engine',
        options: {
          emailRedirectTo: 'http://localhost:3000/auth/callback',
          data: {
            first_name: 'Ada',
            last_name: 'Lovelace',
            display_name: 'Ada Lovelace',
          },
        },
      });
    });
  });

  it('shows the success screen after signUp resolves', async () => {
    render(<SignUp />);
    await fillForm({ email: 'ada@example.com', password: 'hunter22' });

    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
  });

  it('shows the error message when signUp fails', async () => {
    sharedSupabase.auth.signUp.mockResolvedValueOnce({
      data: { user: null },
      error: new Error('Email already registered'),
    });

    render(<SignUp />);
    await fillForm();

    expect(await screen.findByText(/email already registered/i)).toBeInTheDocument();
    // Stays on the form (no success screen).
    expect(screen.queryByText(/check your email/i)).not.toBeInTheDocument();
  });

  it('trims whitespace on first/last name before sending to Supabase', async () => {
    render(<SignUp />);
    await fillForm({
      firstName: '  Grace  ',
      lastName: '  Hopper  ',
      password: 'hunter22',
    });

    await waitFor(() => {
      const call = sharedSupabase.auth.signUp.mock.calls[0][0];
      expect(call.options.data.first_name).toBe('Grace');
      expect(call.options.data.last_name).toBe('Hopper');
      expect(call.options.data.display_name).toBe('Grace Hopper');
    });
  });
});
