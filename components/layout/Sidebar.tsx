'use client';

import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import DashboardIcon from '@mui/icons-material/Dashboard';
import WorkIcon from '@mui/icons-material/Work';
import PeopleIcon from '@mui/icons-material/People';
import CategoryIcon from '@mui/icons-material/Category';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import BuildIcon from '@mui/icons-material/Build';
import RequestQuoteIcon from '@mui/icons-material/RequestQuote';
import GroupIcon from '@mui/icons-material/Group';
import CompanySwitcher from './CompanySwitcher';
import { JiggedIcon } from '@/components/branding';

const menuItems = [
  { name: 'Dashboard', path: '', icon: DashboardIcon },
  { name: 'Quotes', path: '/quotes', icon: RequestQuoteIcon },
  { name: 'Jobs', path: '/jobs', icon: WorkIcon },
  { name: 'Operations', path: '/operations', icon: BuildIcon },
  { name: 'Routings', path: '/routings', icon: AccountTreeIcon },
  { name: 'Inventory', path: '/inventory', icon: Inventory2Icon },
  { name: 'Parts', path: '/parts', icon: CategoryIcon },
  { name: 'Customers', path: '/customers', icon: PeopleIcon },
  { name: 'Team', path: '/team', icon: GroupIcon },
];

export default function Sidebar() {
  const pathname = usePathname();
  const params = useParams();
  const companyId = params.companyId as string;
  const basePath = `/dashboard/${companyId}`;

  return (
    <Box
      component="nav"
      sx={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: 240,
        height: '100vh',
        zIndex: 1200,
        bgcolor: 'rgba(17, 20, 57, 0.8)',
        backdropFilter: 'blur(10px)',
        borderRight: '1px solid rgba(255, 255, 255, 0.1)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Company Switcher */}
      <Box>
        <CompanySwitcher />
      </Box>

      {/* Navigation */}
      <Box sx={{ flex: 1, py: 2, px: 1.5 }}>
        <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {menuItems.map((item) => {
            const fullPath = `${basePath}${item.path}`;
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

      {/* Branding */}
      <Box sx={{ p: 2, display: 'flex', justifyContent: 'center', opacity: 0.5 }}>
        <JiggedIcon size={20} />
      </Box>
    </Box>
  );
}
