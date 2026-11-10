import type { Metadata } from 'next';
import Link from 'next/link';
import Box from '@mui/material/Box';

import LegalPageContainer from '@/components/marketing/LegalPageContainer';

/**
 * The public help page for Jigged's MCP server: how to connect Claude or ChatGPT, what an
 * assistant can do, and the rules it works under. It is the documentation URL both assistant
 * directories ask for, and where a browser opening https://jigged.app/mcp lands (app/mcp/route.ts).
 *
 * Kept in step by hand with the in-app connect dialog (components/aiAssistants/
 * ConnectAssistantDialog.tsx) and the tool catalogue (lib/mcp/server.ts). The setup steps are
 * Claude's and ChatGPT's own screens, so they date: recheck them when either assistant changes.
 */

export const metadata: Metadata = {
  title: 'Use Jigged from Claude or ChatGPT',
  description:
    'Connect your own Claude or ChatGPT to Jigged to ask about jobs, quotes, parts and stock, or have it make changes for you.',
  alternates: { canonical: '/ai-assistants' },
};

const SERVER_URL = 'https://jigged.app/mcp';

export default function AiAssistantsHelpPage() {
  return (
    <LegalPageContainer>
      <Box
        sx={{
          // The legal container styles lists and links but not numbered steps or the URL.
          '& ol': { ml: 3, my: 1.5 },
          '& code': {
            fontFamily: 'monospace',
            fontSize: '0.9em',
            px: 0.75,
            py: 0.25,
            borderRadius: 1,
            bgcolor: 'action.hover',
            wordBreak: 'break-all',
          },
        }}
      >
      <h1>Use Jigged from Claude or ChatGPT</h1>
      <p>
        Connect your own AI assistant to Jigged and ask about your jobs, quotes, parts and stock in
        plain words, or have it make changes for you. It works with your Claude or ChatGPT plan, so
        it uses none of Jigged&apos;s AI credits.
      </p>

      <h2>Connect</h2>
      <p>
        The server URL is <code>{SERVER_URL}</code>. In Jigged, the dashboard&apos;s{' '}
        <strong>Connect your assistant</strong> button does the first step for you.
      </p>

      <h3>Claude</h3>
      <p>Works on claude.ai and in the Claude apps.</p>
      <ol>
        <li>
          In Claude, go to <strong>Settings → Connectors → Add custom connector</strong>, name it
          Jigged and paste the URL. (Jigged&apos;s <strong>Add to Claude</strong> button opens this
          with everything filled in.)
        </li>
        <li>
          Click <strong>Connect</strong>, sign in to Jigged and click <strong>Allow</strong>.
        </li>
        <li>
          In a new chat, turn Jigged on under <strong>+ → Connectors</strong>.
        </li>
      </ol>

      <h3>ChatGPT</h3>
      <p>Set it up once on chatgpt.com, in a web browser.</p>
      <ol>
        <li>
          Open <a href="https://chatgpt.com/plugins">ChatGPT&apos;s Plugins page</a>, click{' '}
          <strong>+</strong>, then <strong>Add custom MCP server</strong>.
        </li>
        <li>
          Name it Jigged, paste the URL, choose <strong>OAuth</strong>, accept the warning and click{' '}
          <strong>Create as a plugin</strong>.
        </li>
        <li>
          Install it, sign in to Jigged and click <strong>Allow</strong>. In a chat, type{' '}
          <strong>@</strong> and pick Jigged.
        </li>
      </ol>
      <p>Any other assistant that supports MCP with OAuth sign-in uses the same URL.</p>

      <h2>What it can do</h2>
      <ul>
        <li>
          <strong>Answer questions</strong> about jobs, quotes, customers, vendors, parts and their
          cost, work centers, stock and locations, shipments, outside processing and QuickBooks
          invoices, and give the dashboard&apos;s figures.
        </li>
        <li>
          <strong>Make changes</strong>: create and update customers, vendors, parts, pricing, bills
          of materials, routings, quotes and jobs; move and adjust stock; ship and send work out.
        </li>
        <li>
          <strong>Bigger steps</strong>: convert a quote to jobs, cancel a job, void a shipment, push
          an invoice to QuickBooks, archive a record, and import records from a spreadsheet.
        </li>
        <li>
          <strong>Reports and charts</strong> from read-only queries over your shop&apos;s data.
        </li>
      </ul>
      <p>For example:</p>
      <ul>
        <li>Which jobs are late, and what is short for them?</li>
        <li>Quote 50 of BRKT-100 for Boeing at the usual lead time.</li>
        <li>Move 20 bearings from Shelf A to Shelf B.</li>
        <li>Ship job J-1042 by UPS Ground.</li>
        <li>Chart revenue by customer for last quarter.</li>
      </ul>

      <h2>Safety and control</h2>
      <ul>
        <li>
          <strong>It acts as you.</strong> It sees and changes only what you can in Jigged, in the
          companies you belong to, under the same rules, including your shop&apos;s subscription.
        </li>
        <li>
          <strong>Office logins only.</strong> Admins and users can connect; operator logins
          can&apos;t.
        </li>
        <li>
          <strong>It asks first.</strong> Your assistant asks before a bigger step: converting a
          quote, cancelling a job, voiding, archiving, importing or pushing an invoice.
        </li>
        <li>
          <strong>No tracking people.</strong> Nothing it returns says who did a piece of work on
          the shop floor.
        </li>
        <li>
          <strong>Disconnect any time.</strong> In Jigged, open your account menu,{' '}
          <strong>AI assistants</strong>, and click <strong>Disconnect</strong>, or remove Jigged in
          your assistant.
        </li>
        <li>
          <strong>What is kept.</strong> Jigged logs each call: which tool, when and how it ended,
          not your conversation. What you ask for is sent to your assistant&apos;s provider
          (Anthropic or OpenAI) under your own account with them. See our{' '}
          <Link href="/privacy">privacy policy</Link>.
        </li>
      </ul>

      <h2>Help</h2>
      <p>
        Questions or problems: <a href="mailto:hello@jigged.app">hello@jigged.app</a>.
      </p>
      </Box>
    </LegalPageContainer>
  );
}
