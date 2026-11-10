'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';

import ConnectAssistantButton from '@/components/aiAssistants/ConnectAssistantDialog';

/**
 * The dashboard's way to the person's OWN assistant: Claude or ChatGPT, connected through Jigged's
 * MCP server, spending their own plan rather than Jigged's AI credits.
 *
 * NEXT TO INSIGHTS, NOT PART OF IT (the user's call, 2026-11-09). It sits under the Insights chat
 * so the two ways of asking about the shop are side by side, but it is its own component on the
 * page, rendered whether or not Insights is: Jigged's own chat may be retired in favour of
 * customers' assistants, and this must survive that without a change.
 *
 * Every office user sees it; there is no per-company switch. Its button opens the connect dialog
 * in place (a Claude card and a ChatGPT card, each with its steps); the person's connected assistants are under AI assistants in the account menu.
 */
export default function ConnectAssistantStrip() {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
      <Box
        component="section"
        aria-labelledby="connect-assistant-heading"
        sx={{
          width: '100%',
          maxWidth: 760,
          display: 'flex',
          alignItems: { xs: 'flex-start', sm: 'center' },
          flexDirection: { xs: 'column', sm: 'row' },
          gap: 2,
          px: 2.5,
          py: 2,
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
        }}
      >
        <SmartToyOutlinedIcon sx={{ color: 'text.secondary', fontSize: 32, display: { xs: 'none', sm: 'block' } }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id="connect-assistant-heading" component="h2" sx={{ fontWeight: 600 }}>
            Use your own AI assistant
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Ask Claude or ChatGPT about your jobs, quotes, parts and stock.
          </Typography>
        </Box>
        <ConnectAssistantButton />
      </Box>
    </Box>
  );
}
