'use client';

import { useParams, useRouter, usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import Paper from '@mui/material/Paper';
import CircularProgress from '@mui/material/CircularProgress';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import LogoutIcon from '@mui/icons-material/Logout';
import WorkIcon from '@mui/icons-material/Work';
import PersonIcon from '@mui/icons-material/Person';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { getSupabase } from '@/lib/supabase';
import { OperatorStationProvider, useStationContext } from '@/components/operator/OperatorStationContext';
import type { AuthChangeEvent } from '@supabase/supabase-js';

/**
 * Operator View layout.
 *
 * Mobile-first layout with:
 * - Top header with operator name, station display, and logout
 * - Bottom navigation bar (Jobs, Profile)
 * - No sidebar (unlike admin dashboard)
 * - Uses Supabase Auth for session management
 * - OperatorStationProvider for shared station state
 */
export default function OperatorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const companyId = params.companyId as string;

  const [operatorName, setOperatorName] = useState<string>('');
  const [navValue, setNavValue] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const supabase = getSupabase();

  // Check authentication on mount
  useEffect(() => {
    const checkAuth = async () => {
      // Skip auth check on login and change-password pages
      if (pathname?.includes('/login') || pathname?.includes('/change-password')) {
        setIsLoading(false);
        return;
      }

      // 1. Get Supabase session
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        router.push(`/operator/${companyId}/login`);
        return;
      }

      // 2. Check if password change required
      if (session.user.user_metadata?.needs_password_change) {
        router.push(`/operator/${companyId}/change-password`);
        return;
      }

      // 3. Validate operator exists for this company (uses user_company_access)
      const { data: operatorAccess } = await supabase
        .from('user_company_access')
        .select('id, name')
        .eq('user_id', session.user.id)
        .eq('company_id', companyId)
        .eq('role', 'operator')
        .single();

      if (!operatorAccess) {
        await supabase.auth.signOut();
        router.push(`/operator/${companyId}/login`);
        return;
      }

      setOperatorName(operatorAccess.name || 'Operator');
      setIsLoading(false);
    };

    checkAuth();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event: AuthChangeEvent) => {
      if (event === 'SIGNED_OUT') {
        router.push(`/operator/${companyId}/login`);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [companyId, router, pathname, supabase]);

  // Update nav value based on current path
  useEffect(() => {
    if (pathname?.includes('/profile')) {
      setNavValue(1);
    } else {
      setNavValue(0);
    }
  }, [pathname]);

  const handleLogout = async () => {
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('jigged_operator_station');
    }
    await supabase.auth.signOut();
    router.push(`/operator/${companyId}/login`);
  };

  const handleNavChange = (_event: React.SyntheticEvent, newValue: number) => {
    setNavValue(newValue);
    switch (newValue) {
      case 0:
        router.push(`/operator/${companyId}/jobs`);
        break;
      case 1:
        router.push(`/operator/${companyId}/profile`);
        break;
    }
  };

  // Don't show header/nav on login or change-password page
  const isAuthPage = pathname?.includes('/login') || pathname?.includes('/change-password');

  if (isAuthPage) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.default',
        }}
      >
        {children}
      </Box>
    );
  }

  // Show loading while checking auth
  if (isLoading) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <OperatorStationProvider>
      <OperatorShell
        operatorName={operatorName}
        companyId={companyId}
        navValue={navValue}
        onNavChange={handleNavChange}
        onLogout={handleLogout}
      >
        {children}
      </OperatorShell>
    </OperatorStationProvider>
  );
}

/**
 * Inner shell component that can access station context.
 */
function OperatorShell({
  operatorName,
  companyId,
  navValue,
  onNavChange,
  onLogout,
  children,
}: {
  operatorName: string;
  companyId: string;
  navValue: number;
  onNavChange: (event: React.SyntheticEvent, newValue: number) => void;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const { stationName, stations, setStation } = useStationContext();
  const router = useRouter();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  const handleStationMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleStationMenuClose = () => {
    setAnchorEl(null);
  };

  const handleStationSelect = (stationId: string) => {
    setStation(stationId);
    setAnchorEl(null);
    router.push(`/operator/${companyId}/jobs`);
  };

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      {/* Top App Bar */}
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          bgcolor: 'rgba(17, 20, 57, 0.95)',
          backdropFilter: 'blur(8px)',
        }}
      >
        <Toolbar sx={{ minHeight: 56 }}>
          <Box sx={{ flexGrow: 1, display: 'flex', alignItems: 'center', minWidth: 0 }}>
            <Typography
              variant="h6"
              component="div"
              sx={{ fontWeight: 500, flexShrink: 0 }}
            >
              {operatorName || 'Operator'}
            </Typography>
            {stationName && (
              <>
                <Typography
                  variant="h6"
                  component="span"
                  sx={{ mx: 1, color: 'rgba(255, 255, 255, 0.3)', fontWeight: 300 }}
                >
                  |
                </Typography>
                <Box
                  onClick={handleStationMenuOpen}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    cursor: 'pointer',
                    minHeight: 48,
                    overflow: 'hidden',
                  }}
                >
                  <Typography
                    variant="body1"
                    sx={{
                      color: 'primary.main',
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {stationName}
                  </Typography>
                  <ArrowDropDownIcon sx={{ color: 'primary.main', ml: 0.5 }} />
                </Box>
              </>
            )}
            {!stationName && stations.length > 0 && (
              <>
                <Typography
                  variant="h6"
                  component="span"
                  sx={{ mx: 1, color: 'rgba(255, 255, 255, 0.3)', fontWeight: 300 }}
                >
                  |
                </Typography>
                <Box
                  onClick={handleStationMenuOpen}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    cursor: 'pointer',
                    minHeight: 48,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{ color: 'rgba(255, 255, 255, 0.5)' }}
                  >
                    Select Station
                  </Typography>
                  <ArrowDropDownIcon sx={{ color: 'rgba(255, 255, 255, 0.5)', ml: 0.5 }} />
                </Box>
              </>
            )}
          </Box>

          {/* Station Selector Menu */}
          <Menu
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={handleStationMenuClose}
            slotProps={{
              paper: {
                sx: {
                  maxHeight: 300,
                  minWidth: 200,
                },
              },
            }}
          >
            {stations.map((station) => (
              <MenuItem
                key={station.id}
                onClick={() => handleStationSelect(station.id)}
                sx={{ minHeight: 48 }}
              >
                <ListItemText primary={station.name} />
              </MenuItem>
            ))}
          </Menu>

          <IconButton
            color="inherit"
            onClick={onLogout}
            aria-label="logout"
            sx={{ minWidth: 48, minHeight: 48 }}
          >
            <LogoutIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      {/* Main Content */}
      <Box
        component="main"
        sx={{
          flex: 1,
          mt: '56px', // AppBar height
          mb: '56px', // BottomNavigation height
          overflow: 'auto',
          p: 2,
        }}
      >
        {children}
      </Box>

      {/* Bottom Navigation */}
      <Paper
        sx={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 1000,
        }}
        elevation={3}
      >
        <BottomNavigation
          value={navValue}
          onChange={onNavChange}
          showLabels
          sx={{
            bgcolor: 'rgba(17, 20, 57, 0.98)',
            '& .MuiBottomNavigationAction-root': {
              color: 'rgba(255, 255, 255, 0.5)',
              minWidth: 80,
              '&.Mui-selected': {
                color: 'primary.main',
              },
            },
          }}
        >
          <BottomNavigationAction
            label="Jobs"
            icon={<WorkIcon />}
            sx={{ minHeight: 56 }}
          />
          <BottomNavigationAction
            label="Profile"
            icon={<PersonIcon />}
            sx={{ minHeight: 56 }}
          />
        </BottomNavigation>
      </Paper>
    </Box>
  );
}
