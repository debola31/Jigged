'use client';

import AiAssistantsPanel from '@/components/aiAssistants/AiAssistantsPanel';

/**
 * The assistants this person has connected (ChatGPT, Claude, …), with Disconnect. Reached from
 * the account menu; connecting itself is a menu, on the dashboard and in this page's header. Under /dashboard so AuthGuard signs people
 * in and keeps operators out, though the connections it lists are the person's own, across every
 * company they belong to.
 */
export default function AiAssistantsPage() {
  return <AiAssistantsPanel />;
}
