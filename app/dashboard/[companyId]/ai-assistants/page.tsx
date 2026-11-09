'use client';

import AiAssistantsPanel from '@/components/aiAssistants/AiAssistantsPanel';

/**
 * Connect ChatGPT or Claude to Jigged, and manage the assistants already connected. Reached from
 * the dashboard (under Insights) and from the account menu. Under /dashboard so AuthGuard signs people
 * in and keeps operators out, though the connections it lists are the person's own, across every
 * company they belong to.
 */
export default function AiAssistantsPage() {
  return <AiAssistantsPanel />;
}
