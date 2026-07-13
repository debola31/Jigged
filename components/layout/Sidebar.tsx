'use client';

import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Skeleton from '@mui/material/Skeleton';
import DashboardIcon from '@mui/icons-material/Dashboard';
import DynamicFeedIcon from '@mui/icons-material/DynamicFeed';
import WorkIcon from '@mui/icons-material/Work';
import BusinessIcon from '@mui/icons-material/Business';
import CategoryIcon from '@mui/icons-material/Category';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import PrecisionManufacturingIcon from '@mui/icons-material/PrecisionManufacturing';
import FactoryIcon from '@mui/icons-material/Factory';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';
import GroupIcon from '@mui/icons-material/Group';
import SettingsIcon from '@mui/icons-material/Settings';
import FeedbackIcon from '@mui/icons-material/Feedback';
import CompanySwitcher from './CompanySwitcher';
import { useUserRole } from '@/hooks/useUserRole';
import { useCompanyFeatures } from '@/hooks/useCompanyFeatures';
import type { KnownFeatureKey } from '@/lib/featureFlags';

const SIDEBAR_WIDTH = 240;

interface MenuItem {
  name: string;
  path: string;
  icon: typeof DashboardIcon;
  adminOnly?: boolean;
  /**
   * When set, the item only renders if the named feature flag is on for
   * the current company. While the company feature data is still loading,
   * the renderer shows a Skeleton placeholder in this item's slot so the
   * sidebar doesn't visibly grow when the flag resolves.
   */
  featureFlag?: KnownFeatureKey;
}

const menuItems: MenuItem[] = [
  { name: 'Dashboard', path: '', icon: DashboardIcon },
  { name: 'Activity', path: '/activity', icon: DynamicFeedIcon },
  { name: 'Jobs', path: '/jobs', icon: WorkIcon },
  { name: 'Quotes', path: '/quotes', icon: RequestQuoteIcon },
  { name: 'Parts', path: '/parts', icon: CategoryIcon },
  { name: 'Inventory', path: '/inventory', icon: Inventory2Icon },
  { name: 'Work Centers', path: '/work-centers', icon: PrecisionManufacturingIcon },
  { name: 'Vendors', path: '/vendors', icon: FactoryIcon },
  { name: 'Customers', path: '/customers', icon: BusinessIcon },
  { name: 'Team', path: '/team', icon: GroupIcon, adminOnly: true },
  { name: 'Settings', path: '/settings', icon: SettingsIcon, adminOnly: true },
];

interface SidebarProps {
  isMobile: boolean;
  open: boolean;
  onClose: () => void;
  onFeedbackClick?: () => void;
}

export default function Sidebar({ isMobile, open, onClose, onFeedbackClick }: SidebarProps) {
  const pathname = usePathname();
  const params = useParams();
  const companyId = params.companyId as string;
  const basePath = `/dashboard/${companyId}`;
  const { isAdmin } = useUserRole();
  const { features, loading: featuresLoading } = useCompanyFeatures();

  const drawerContent = (
    <>
      {/* Company Switcher */}
      <Box sx={{ pt: 1 }}>
        <CompanySwitcher />
      </Box>

      {/* Navigation */}
      <Box component="nav" aria-label="Main navigation" sx={{ flex: 1, py: 2, px: 1.5 }}>
        <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {menuItems
            .filter((item) => !item.adminOnly || isAdmin)
            // For feature-flagged items: while loading we keep the slot in
            // the list (rendered as a Skeleton below) so the sidebar doesn't
            // visibly grow when the flag resolves. Once loaded, drop the
            // item entirely when the flag is off.
            .filter((item) => !item.featureFlag || featuresLoading || features[item.featureFlag])
            .map((item) => {
              const fullPath = `${basePath}${item.path}`;
              // Hold the slot with a skeleton while features load; we don't
              // know yet whether to show the live item.
              if (item.featureFlag && featuresLoading) {
                return (
                  <ListItem key={`skeleton-${item.path}`} disablePadding>
                    <Box sx={{ px: 2, py: 1.5, width: '100%' }}>
                      <Skeleton
                        variant="rectangular"
                        height={24}
                        sx={{ bgcolor: 'rgba(255, 255, 255, 0.08)', borderRadius: 1 }}
                      />
                    </Box>
                  </ListItem>
                );
              }
              // For root path (Dashboard), check exact match; for others, check if pathname starts with the path
              const isActive = item.path === ''
                ? pathname === fullPath
                : pathname.startsWith(fullPath);
              const IconComponent = item.icon;

              return (
                <ListItem key={item.path} disablePadding>
                  <ListItemButton
                    component={Link}
                    href={fullPath}
                    onClick={isMobile ? onClose : undefined}
                    sx={{
                      borderRadius: 2,
                      py: 1.5,
                      px: 2,
                      bgcolor: isActive ? 'primary.main' : 'transparent',
                      color: isActive ? 'white' : 'rgba(255, 255, 255, 0.7)',
                      transition: 'all 0.2s ease',
                      '&:hover': {
                        bgcolor: isActive ? 'primary.main' : 'rgba(255, 255, 255, 0.08)',
                        color: 'white',
                      },
                    }}
                  >
                    <ListItemIcon
                      sx={{
                        minWidth: 40,
                        color: 'inherit',
                      }}
                    >
                      <IconComponent />
                    </ListItemIcon>
                    <ListItemText
                      primary={item.name}
                      slotProps={{
                        primary: {
                          sx: {
                            fontWeight: isActive ? 600 : 500,
                            fontSize: '0.95rem',
                          },
                        },
                      }}
                    />
                  </ListItemButton>
                </ListItem>
              );
            })}
        </List>
      </Box>

      {/* Feedback button at bottom of sidebar */}
      {onFeedbackClick && (
        <Box sx={{ px: 1.5, pb: 2 }}>
          <ListItemButton
            onClick={onFeedbackClick}
            sx={{
              borderRadius: 2,
              py: 1.5,
              px: 2,
              color: 'rgba(255, 255, 255, 0.7)',
              transition: 'all 0.2s ease',
              '&:hover': {
                bgcolor: 'rgba(255, 255, 255, 0.08)',
                color: 'white',
              },
            }}
          >
            <ListItemIcon sx={{ minWidth: 40, color: 'inherit' }}>
              <FeedbackIcon />
            </ListItemIcon>
            <ListItemText
              primary="Feedback"
              slotProps={{
                primary: { sx: { fontWeight: 500, fontSize: '0.95rem' } },
              }}
            />
          </ListItemButton>
        </Box>
      )}
    </>
  );

  const paperSx = {
    width: SIDEBAR_WIDTH,
    bgcolor: 'rgba(17, 20, 57, 0.8)',
    backdropFilter: 'blur(10px)',
    borderRight: '1px solid rgba(255, 255, 255, 0.1)',
    display: 'flex',
    flexDirection: 'column',
  };

  if (isMobile) {
    return (
      <Drawer
        variant="temporary"
        open={open}
        onClose={onClose}
        ModalProps={{ keepMounted: true }}
        sx={{
          '& .MuiDrawer-paper': paperSx,
        }}
      >
        {drawerContent}
      </Drawer>
    );
  }

  return (
    <Drawer
      variant="permanent"
      sx={{
        '& .MuiDrawer-paper': {
          ...paperSx,
          position: 'fixed',
          height: '100vh',
          zIndex: 1200,
        },
      }}
    >
      {drawerContent}
    </Drawer>
  );
}
