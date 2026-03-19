import type { Metadata } from 'next';
import Box from '@mui/material/Box';
import LegalPageContainer from '@/components/marketing/LegalPageContainer';

export const metadata: Metadata = {
  title: 'Cookie Policy – Jigged',
  description: 'Jigged Cookie Policy — how we use cookies and similar technologies.',
};

export default function CookiesPage() {
  return (
    <LegalPageContainer>
      <Box
        sx={{
          '& .last-updated': {
            fontSize: 14,
            color: '#6b7280',
            mb: 6,
            pb: 3,
            borderBottom: '1px solid rgba(70, 130, 180, 0.2)',
          },
          '& .cookie-table': {
            width: '100%',
            borderCollapse: 'collapse',
            my: 3,
            '& th, & td': {
              textAlign: 'left',
              p: 1.5,
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              fontSize: 14,
            },
            '& th': {
              color: '#f3f4f6',
              fontWeight: 600,
              borderBottom: '1px solid rgba(70, 130, 180, 0.2)',
            },
            '& td': {
              color: '#d1d5db',
            },
            '& code': {
              fontSize: 13,
              color: '#4682B4',
              background: 'rgba(70, 130, 180, 0.1)',
              px: 0.75,
              py: 0.25,
              borderRadius: 1,
            },
          },
          '& .contact-block': {
            mt: 2,
            p: 2.5,
            background: 'rgba(70, 130, 180, 0.06)',
            border: '1px solid rgba(70, 130, 180, 0.12)',
            borderRadius: 2,
            '& p': { mb: 0.5 },
          },
          '& .section-divider': {
            border: 'none',
            borderTop: '1px solid rgba(70, 130, 180, 0.1)',
            my: 5,
          },
        }}
        dangerouslySetInnerHTML={{
          __html: `
    <h1>Cookie Policy</h1>
    <p class="last-updated">Last updated: March 18, 2026</p>

    <h2>What Are Cookies</h2>
    <p>Cookies are small text files that are stored on your device (computer, tablet, or mobile) when you visit a website. They are widely used to make websites work more efficiently and to provide information to the site owners. This Cookie Policy explains what cookies Jigged uses and why.</p>

    <hr class="section-divider">

    <h2>Cookies We Use</h2>
    <p>Jigged uses a limited number of cookies, all of which serve functional or performance purposes. We do not use cookies for advertising or behavioral tracking.</p>

    <h3>Essential Cookies (Required)</h3>
    <p>These cookies are strictly necessary for the application to function. They cannot be disabled.</p>
    <table class="cookie-table">
      <thead>
        <tr>
          <th>Cookie</th>
          <th>Purpose</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>sb-*-auth-token</code></td>
          <td>Supabase authentication session token. Maintains your login session so you don't have to sign in on every page.</td>
          <td>Session / 1 hour</td>
        </tr>
        <tr>
          <td><code>sb-*-auth-token-code-verifier</code></td>
          <td>PKCE code verifier for secure authentication flows.</td>
          <td>Session</td>
        </tr>
      </tbody>
    </table>

    <h3>Performance Cookies</h3>
    <p>These cookies help us monitor application stability and fix errors.</p>
    <table class="cookie-table">
      <thead>
        <tr>
          <th>Cookie</th>
          <th>Purpose</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>sentry-sc</code></td>
          <td>Sentry error monitoring. Tracks application errors and performance issues so we can identify and fix bugs.</td>
          <td>Session</td>
        </tr>
      </tbody>
    </table>

    <h3>Hosting Cookies</h3>
    <p>Our hosting provider (Vercel) may set functional cookies for load balancing, security, and deployment purposes.</p>
    <table class="cookie-table">
      <thead>
        <tr>
          <th>Cookie</th>
          <th>Purpose</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>__vercel_live_token</code></td>
          <td>Used in preview/staging environments for deployment functionality. Not present in production.</td>
          <td>Session</td>
        </tr>
      </tbody>
    </table>

    <hr class="section-divider">

    <h2>Advertising and Analytics Cookies</h2>
    <p>Jigged does not currently use any third-party advertising cookies, analytics tracking cookies, or social media cookies. We do not track your browsing activity across other websites, and we do not share cookie data with advertisers.</p>
    <p>If this changes in the future, we will update this policy and notify you before any such cookies are introduced.</p>

    <hr class="section-divider">

    <h2>Managing Cookies</h2>
    <p>Most web browsers allow you to control cookies through their settings. You can typically find these options in your browser's "Settings," "Preferences," or "Privacy" menu. Common options include:</p>
    <ul>
      <li>Viewing what cookies are currently stored and deleting them individually</li>
      <li>Blocking all or third-party cookies</li>
      <li>Setting your browser to notify you when a cookie is being set</li>
      <li>Clearing all cookies when you close the browser</li>
    </ul>
    <p>Please note that if you disable essential cookies, you will not be able to log in to Jigged or use the application's core features.</p>

    <hr class="section-divider">

    <h2>Changes to This Policy</h2>
    <p>We may update this Cookie Policy from time to time to reflect changes in our practices or for operational, legal, or regulatory reasons. We will update the "Last updated" date at the top of this page when we make changes.</p>

    <hr class="section-divider">

    <h2>Contact Us</h2>
    <p>If you have questions about our use of cookies, please contact us at:</p>
    <div class="contact-block">
      <p><strong>Jigged</strong></p>
      <p><a href="mailto:legal@jigged.app">legal@jigged.app</a></p>
    </div>
          `,
        }}
      />
    </LegalPageContainer>
  );
}
