'use client';

/**
 * The company name in the AppBar's centre slot, while no station is chosen.
 *
 * ## The one place the operator surface says which shop this is
 *
 * That slot used to be empty before a station was picked — it renders the station chip and
 * nothing else — so the station picker, which also hides the bottom nav, identified nothing at
 * all. The operator LOGIN page one screen earlier does show the company name; it then vanished at
 * exactly the moment you commit to a working context. A person who works two shops, or who has
 * just stepped into the practice company, had nothing to check against.
 *
 * ## Why the header rather than the picker card
 *
 * Both were tried, and showing it in both put the same words on screen twice within about 100px.
 * The header wins the single slot for two reasons: the picker card is absent on the OTHER screens
 * reachable without a station ("Me" and Inventory both are), and this slot is already where the
 * operator looks for "where am I" once a station exists. One fact, one place, same position
 * whichever screen you are on.
 *
 * ## It is a LABEL, not a control, and that is load-bearing
 *
 * The operator AppBar carries a documented prohibition on adding tap targets — two small targets
 * side by side is the worst case in Fitts's law, and because touch platforms resolve a tap to the
 * nearest control, missing one fires the other. That reasoning covers promoting inert text into a
 * button just as much as adding an icon, so making this tappable ("switch company from the
 * header") is exactly what must not happen. The switcher lives in the "Me" tab; see
 * `OperatorCompanySwitcher`, whose own header makes the same point about the identity row.
 *
 * Renders nothing once a station is selected — the station chip takes the slot — and nothing while
 * the name is still resolving, rather than reserving a blank space that pops.
 */

import Typography from '@mui/material/Typography';

import { useOperatorCompany } from '@/components/operator/OperatorCompanyContext';
import { useStationContext } from '@/components/operator/OperatorStationContext';

export default function OperatorCompanyLabel() {
  const { stationId } = useStationContext();
  const { companyName } = useOperatorCompany();

  if (stationId || !companyName) return null;

  return (
    <Typography
      variant="body1"
      component="span"
      sx={{
        alignSelf: 'center',
        fontWeight: 600,
        // Just under full white: this is orientation, not the page's subject, and it must not
        // compete with the station chip that replaces it.
        color: 'rgba(255, 255, 255, 0.85)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {companyName}
    </Typography>
  );
}
