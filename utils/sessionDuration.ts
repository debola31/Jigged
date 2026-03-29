/**
 * Calculate total run minutes from a list of operator sessions.
 * Sums (ended_at - started_at) for each session individually,
 * excluding idle gaps between stop/restart sessions.
 */
export function calculateActualRunMinutes(
  sessions: { started_at: string; ended_at: string }[]
): number {
  const totalMs = sessions.reduce((sum, s) => {
    const start = new Date(s.started_at).getTime();
    const end = new Date(s.ended_at).getTime();
    return sum + (end - start);
  }, 0);
  return totalMs / (1000 * 60);
}
