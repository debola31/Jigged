'use client';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Typography from '@mui/material/Typography';

import { STORAGE_TYPES, type StorageType } from './storageTypes';

interface StorageTypePaletteProps {
  selectedId: string | null;
  onSelect: (type: StorageType) => void;
}

/** Step 1: pick a recognizable storage type. Each card = concrete icon + an
 *  always-visible label (NN/g 5-second rule), tap target well over 48px. */
export default function StorageTypePalette({ selectedId, onSelect }: StorageTypePaletteProps) {
  return (
    <Box>
      <Typography variant="body1" sx={{ mb: 2 }}>
        What kind of storage are you setting up?
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)', md: 'repeat(4, 1fr)' },
        }}
      >
        {STORAGE_TYPES.map((type) => {
          const selected = type.id === selectedId;
          const Icon = type.Icon;
          return (
            <Card
              key={type.id}
              elevation={selected ? 4 : 2}
              sx={{
                border: 2,
                borderColor: selected ? 'primary.main' : 'transparent',
              }}
            >
              <CardActionArea
                onClick={() => onSelect(type)}
                sx={{
                  p: 2,
                  minHeight: 120,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  gap: 1,
                }}
              >
                <Icon sx={{ fontSize: 40, color: selected ? 'primary.main' : 'text.secondary' }} />
                <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
                  {type.label}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {type.description}
                </Typography>
              </CardActionArea>
            </Card>
          );
        })}
      </Box>
    </Box>
  );
}
