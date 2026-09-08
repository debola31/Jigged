'use client';

import { useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Skeleton from '@mui/material/Skeleton';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CheckIcon from '@mui/icons-material/Check';
import { useCompanies } from '@/hooks/useCompanies';
import { useCompanyLogos } from '@/hooks/useCompanyLogos';
import { homePathForRole } from '@/utils/companyAccess';
import { useDemoMode } from '@/components/providers/DemoModeProvider';
import { JiggedLogo } from '@/components/branding';
import CompanyIdentity from '@/components/common/CompanyIdentity';

export default function CompanySwitcher() {
  const router = useRouter();
  const params = useParams();
  const currentCompanyId = params.companyId as string;
  const { companies, loading } = useCompanies();
  const { logoUrls, refreshLogoUrls } = useCompanyLogos(companies);
  const { isDemoMode, realCompanyName } = useDemoMode();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hasMultipleCompanies = companies.length > 1;

  const currentCompany = companies.find(
    (c) => c.company_id === currentCompanyId
  );

  const handleOpen = () => {
    if (hasMultipleCompanies) {
      setDrawerOpen(true);
      // Re-mint on open: signed logo URLs outlive an hour and an office tab does not get reloaded
      // that often. `refresh` keeps the current artwork on screen while the new URLs land.
      void refreshLogoUrls();
    }
  };
  const handleClose = () => setDrawerOpen(false);

  // Role-aware, because a user's role is per-company: someone who is an admin here can be an
  // operator there. Hardcoding /dashboard sent that person to a page AuthGuard immediately bounces
  // them out of. `homePathForRole` is the shared helper precisely so the four "send them home"
  // call sites can't drift.
  const handleSelectCompany = (companyId: string, role: string | null | undefined) => {
    handleClose();
    if (companyId !== currentCompanyId) {
      router.push(homePathForRole(role, companyId));
    }
  };

  if (loading) {
    return (
      <Box sx={{ p: 2 }}>
        <Skeleton variant="rectangular" width="100%" height={48} sx={{ borderRadius: 2 }} />
      </Box>
    );
  }

  // In demo mode, show the real company name (not the internal "X - Demo" name)
  const companyName = isDemoMode
    ? realCompanyName || 'Select Company'
    : currentCompany?.companies?.name || 'Select Company';

  // Demo mode keeps the initials. The name above is substituted for the demo company's own, and a
  // real shop's wordmark pinned over a substituted name would say something false about which
  // workspace this is.
  const triggerLogoUrl = isDemoMode
    ? null
    : (currentCompany && logoUrls.get(currentCompany.company_id)) || null;

  return (
    <>
      <Box sx={{ p: 1.5 }}>
        <ButtonBase
          onClick={handleOpen}
          disabled={!hasMultipleCompanies}
          sx={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            p: 1.5,
            borderRadius: 2,
            transition: 'background-color 0.2s',
            cursor: hasMultipleCompanies ? 'pointer' : 'default',
            '&:hover': {
              bgcolor: hasMultipleCompanies ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
            },
          }}
        >
          <CompanyIdentity
            name={companyName}
            logoUrl={triggerLogoUrl}
            variant="trigger"
            trailing={
              hasMultipleCompanies ? (
                <KeyboardArrowDownIcon sx={{ color: 'rgba(255, 255, 255, 0.7)' }} />
              ) : null
            }
          />
        </ButtonBase>
      </Box>

      <Drawer
        anchor="left"
        open={drawerOpen}
        onClose={handleClose}
        slotProps={{
          paper: {
            sx: {
              width: 280,
              bgcolor: 'rgba(17, 20, 57, 0.98)',
              backdropFilter: 'blur(20px)',
              borderRight: '1px solid rgba(255, 255, 255, 0.1)',
            },
          },
        }}
      >
        {/* Header */}
        <Box sx={{ p: 3 }}>
          <Typography
            variant="overline"
            sx={{
              color: 'rgba(255, 255, 255, 0.5)',
              letterSpacing: 1.5,
              fontWeight: 600,
            }}
          >
            Workspaces
          </Typography>
        </Box>

        {/* Company List */}
        <List sx={{ flex: 1, px: 1.5 }}>
          {companies.map((company) => {
            const isSelected = company.company_id === currentCompanyId;
            const name = company.companies?.name || 'Unknown';
            const role = company.role;

            return (
              <ListItem key={company.company_id} disablePadding sx={{ mb: 0.5 }}>
                <ListItemButton
                  onClick={() => handleSelectCompany(company.company_id, role)}
                  sx={{
                    borderRadius: 2,
                    py: 1.5,
                    bgcolor: isSelected ? 'rgba(70, 130, 180, 0.2)' : 'transparent',
                    border: isSelected ? '1px solid rgba(70, 130, 180, 0.3)' : '1px solid transparent',
                    '&:hover': {
                      bgcolor: isSelected
                        ? 'rgba(70, 130, 180, 0.25)'
                        : 'rgba(255, 255, 255, 0.08)',
                    },
                  }}
                >
                  <CompanyIdentity
                    name={name}
                    role={role.charAt(0).toUpperCase() + role.slice(1)}
                    logoUrl={logoUrls.get(company.company_id) ?? null}
                    emphasised={isSelected}
                    trailing={
                      isSelected ? (
                        <CheckIcon sx={{ fontSize: 20, color: 'primary.main' }} />
                      ) : null
                    }
                  />
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>

        <Divider sx={{ borderColor: 'rgba(255, 255, 255, 0.1)', mx: 2 }} />

        {/* Footer */}
        <Box sx={{ p: 1.5, display: 'flex', justifyContent: 'center' }}>
          <JiggedLogo size="small" />
        </Box>
      </Drawer>
    </>
  );
}
