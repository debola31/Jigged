'use client';

import { useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import Avatar from '@mui/material/Avatar';
import Divider from '@mui/material/Divider';
import Skeleton from '@mui/material/Skeleton';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CheckIcon from '@mui/icons-material/Check';
import { useCompanies } from '@/hooks/useCompanies';
import { JiggedLogo } from '@/components/branding';

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function getAvatarColor(name: string): string {
  const colors = [
    '#4682B4', '#6FA3D8', '#2E5A8A', '#3B82F6',
    '#8B5CF6', '#10B981', '#F59E0B', '#EF4444'
  ];
  const index = name.charCodeAt(0) % colors.length;
  return colors[index];
}

export default function CompanySwitcher() {
  const router = useRouter();
  const params = useParams();
  const currentCompanyId = params.companyId as string;
  const { companies, loading } = useCompanies();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hasMultipleCompanies = companies.length > 1;

  const currentCompany = companies.find(
    (c) => c.company_id === currentCompanyId
  );

  const handleOpen = () => {
    if (hasMultipleCompanies) {
      setDrawerOpen(true);
    }
  };
  const handleClose = () => setDrawerOpen(false);

  const handleSelectCompany = (companyId: string) => {
    handleClose();
    if (companyId !== currentCompanyId) {
      router.push(`/dashboard/${companyId}`);
    }
  };

  if (loading) {
    return (
      <Box sx={{ p: 2 }}>
        <Skeleton variant="rectangular" width="100%" height={48} sx={{ borderRadius: 2 }} />
      </Box>
    );
  }

  const companyName = currentCompany?.companies?.name || 'Select Company';

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
          <Avatar
            sx={{
              width: 36,
              height: 36,
              bgcolor: getAvatarColor(companyName),
              fontSize: '0.875rem',
              fontWeight: 600,
            }}
          >
            {getInitials(companyName)}
          </Avatar>
          <Box sx={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
            <Typography
              variant="subtitle2"
              sx={{
                fontWeight: 600,
                color: 'white',
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                lineHeight: 1.3,
              }}
            >
              {companyName}
            </Typography>
          </Box>
          {hasMultipleCompanies && (
            <KeyboardArrowDownIcon sx={{ color: 'rgba(255, 255, 255, 0.7)' }} />
          )}
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
                  onClick={() => handleSelectCompany(company.company_id)}
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
                  <ListItemIcon>
                    <Avatar
                      sx={{
                        width: 40,
                        height: 40,
                        bgcolor: getAvatarColor(name),
                        fontSize: '0.9rem',
                        fontWeight: 600,
                      }}
                    >
                      {getInitials(name)}
                    </Avatar>
                  </ListItemIcon>
                  <ListItemText
                    primary={name}
                    secondary={role.charAt(0).toUpperCase() + role.slice(1)}
                    slotProps={{
                      primary: {
                        sx: {
                          fontWeight: isSelected ? 600 : 500,
                          fontSize: '0.95rem',
                          color: 'white',
                        },
                      },
                      secondary: {
                        sx: {
                          fontSize: '0.75rem',
                          color: 'rgba(255, 255, 255, 0.5)',
                        },
                      },
                    }}
                  />
                  {isSelected && (
                    <CheckIcon sx={{ fontSize: 20, color: 'primary.main' }} />
                  )}
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
