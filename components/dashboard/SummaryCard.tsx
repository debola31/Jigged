'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import { SvgIconComponent } from '@mui/icons-material';

interface SummaryCardProps {
  title: string;
  value: string | number;
  icon: SvgIconComponent;
  color?: 'default' | 'success' | 'warning' | 'error';
  onClick?: () => void;
  loading?: boolean;
}

/**
 * Summary card for dashboard metrics.
 * Displays a large value with a title and optional icon.
 * Clickable to navigate to detailed views.
 */
export default function SummaryCard({
  title,
  value,
  icon: Icon,
  color = 'default',
  onClick,
  loading = false,
}: SummaryCardProps) {
  // Color mappings for different states
  const colorMap = {
    default: {
      bg: 'rgba(70, 130, 180, 0.08)', // Steel Blue tint
      border: 'rgba(70, 130, 180, 0.2)',
      iconColor: 'primary.main',
    },
    success: {
      bg: 'rgba(16, 185, 129, 0.08)',
      border: 'rgba(16, 185, 129, 0.2)',
      iconColor: 'success.main',
    },
    warning: {
      bg: 'rgba(245, 158, 11, 0.08)',
      border: 'rgba(245, 158, 11, 0.2)',
      iconColor: 'warning.main',
    },
    error: {
      bg: 'rgba(239, 68, 68, 0.08)',
      border: 'rgba(239, 68, 68, 0.2)',
      iconColor: 'error.main',
    },
  };

  const colors = colorMap[color];

  const cardContent = (
    <CardContent sx={{ py: 3 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
        }}
      >
        <Box>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mb: 0.5, fontWeight: 500 }}
          >
            {title}
          </Typography>
          {loading ? (
            <Skeleton variant="text" width={80} height={48} />
          ) : (
            <Typography
              variant="h3"
              component="div"
              sx={{ fontWeight: 600, lineHeight: 1.2 }}
            >
              {value}
            </Typography>
          )}
        </Box>
        <Box
          sx={{
            p: 1,
            borderRadius: 2,
            bgcolor: colors.bg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon sx={{ fontSize: 28, color: colors.iconColor }} />
        </Box>
      </Box>
    </CardContent>
  );

  return (
    <Card
      elevation={2}
      sx={{
        '&:hover': onClick
          ? {
              transform: 'translateY(-2px)',
              boxShadow: 4,
            }
          : {},
      }}
    >
      {onClick ? (
        <CardActionArea onClick={onClick}>{cardContent}</CardActionArea>
      ) : (
        cardContent
      )}
    </Card>
  );
}
