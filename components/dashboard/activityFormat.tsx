import type { SvgIconComponent } from '@mui/icons-material';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import WorkOutlineIcon from '@mui/icons-material/WorkOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import LocalShippingOutlinedIcon from '@mui/icons-material/LocalShippingOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import PhotoCameraOutlinedIcon from '@mui/icons-material/PhotoCameraOutlined';
import PrecisionManufacturingOutlinedIcon from '@mui/icons-material/PrecisionManufacturingOutlined';
import type { ActivityItem } from '@/utils/dashboardAccess';

/**
 * Shared formatting for the activity feed so the dashboard card, the /activity
 * page, and any future surface render identical icons, labels, and timestamps
 * (one source of truth — no drift between surfaces).
 */

/** Relative time for recency-focused reading ("5m ago", "2h ago", "yesterday"). */
export function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/** Absolute timestamp for tooltip/long-press (older items need the real date). */
export function formatAbsoluteTime(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Icon + theme color for an activity row, keyed by type then action. */
export function getActivityVisual(item: ActivityItem): { icon: SvgIconComponent; color: string } {
  switch (item.type) {
    case 'quote':
      return { icon: DescriptionOutlinedIcon, color: 'primary.main' };
    case 'note':
      return { icon: StickyNote2OutlinedIcon, color: 'text.secondary' };
    case 'photo':
      return { icon: PhotoCameraOutlinedIcon, color: 'info.main' };
    case 'shipment':
      return { icon: LocalShippingOutlinedIcon, color: 'secondary.main' };
    case 'inventory':
      // Colour means the amount on hand changed, or something needs attention — the same policy
      // the operator's feed settled on. A MOVE changes no total, so it stays neutral rather than
      // claiming a third meaning for a third hue.
      if (item.action === 'stock_in') return { icon: Inventory2OutlinedIcon, color: 'success.main' };
      if (item.action === 'stock_out') return { icon: Inventory2OutlinedIcon, color: 'warning.main' };
      return { icon: Inventory2OutlinedIcon, color: 'text.secondary' };
    case 'operation':
      // Outside-op send/receive get the truck (amber out, green back); internal
      // completion keeps the machining icon.
      if (item.action === 'sent') return { icon: LocalShippingOutlinedIcon, color: 'warning.main' };
      if (item.action === 'received') return { icon: LocalShippingOutlinedIcon, color: 'success.main' };
      return { icon: PrecisionManufacturingOutlinedIcon, color: 'success.main' };
    case 'job':
    default:
      switch (item.action) {
        case 'started':
          return { icon: PlayArrowIcon, color: 'info.main' };
        case 'completed':
          return { icon: CheckCircleOutlineIcon, color: 'success.main' };
        case 'shipped':
          return { icon: LocalShippingOutlinedIcon, color: 'secondary.main' };
        case 'created':
        default:
          return { icon: WorkOutlineIcon, color: 'primary.main' };
      }
  }
}

/** One-line, scannable description of what happened (the entity number is shown separately). */
export function formatActivityText(item: ActivityItem): string {
  const who = item.authorName || 'Someone';
  switch (item.type) {
    case 'quote':
      return item.customerName ? `Quote created for ${item.customerName}` : 'Quote created';
    case 'shipment':
      return item.customerName ? `Shipped to ${item.customerName}` : 'Shipped';
    case 'inventory': {
      const where = item.locationName ? ` at ${item.locationName}` : '';
      const qty = item.quantityLabel ?? '';
      if (item.action === 'moved') return `${qty} moved to ${item.locationName ?? 'another place'}`;
      if (item.action === 'stock_in') return `${qty} added${where}`;
      if (item.action === 'stock_out') return `${qty} taken${where}`;
      return `Counted — set to ${qty}${where}`;
    }
    case 'note':
      return `${who} added a note`;
    case 'photo':
      return `${who} added a photo`;
    case 'operation':
      if (item.action === 'sent')
        return item.vendorName ? `Sent to ${item.vendorName}` : 'Sent to vendor';
      if (item.action === 'received')
        return item.vendorName ? `Received from ${item.vendorName}` : 'Received from vendor';
      return 'Operation completed';
    case 'job':
    default:
      switch (item.action) {
        case 'started':
          return 'Work started';
        case 'completed':
          return 'Job completed';
        case 'created':
        default:
          return item.customerName ? `Job created for ${item.customerName}` : 'Job created';
      }
  }
}
