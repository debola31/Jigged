'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import NextLink from 'next/link';
import {
  Card,
  CardContent,
  Box,
  Typography,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  CircularProgress,
} from '@mui/material';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import { getBomForPart } from '@/utils/bomAccess';
import type { BomLineWithChildPart } from '@/types/bom';

interface JobPartMaterialsCardProps {
  /** The made part this job_part produces (job_parts.part_id). */
  partId: string;
  /**
   * The job_part order quantity. When provided, each material row also shows
   * the total this job draws — ceil(order_qty × per-part qty) for whole-unit
   * lines — so the shop floor never sees a meaningless "0.05 strips per unit".
   */
  orderQuantity?: number;
}

const formatMatQty = (n: number): string =>
  n.toLocaleString(undefined, { maximumFractionDigits: 4 });

/**
 * Read-only materials list for a job part, sourced LIVE from the part's BOM
 * (parts_bom) rather than the job_materials snapshot. Material consumption is
 * no longer tracked per job — the part BOM is the source of truth, so the Job
 * page reflects the current BOM. Quantities are per unit of the part; when the
 * order quantity is known, each row also shows the whole-order total.
 */
export default function JobPartMaterialsCard({ partId, orderQuantity }: JobPartMaterialsCardProps) {
  const params = useParams();
  const companyId = params.companyId as string;
  const [lines, setLines] = useState<BomLineWithChildPart[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBomForPart(partId)
      .then((data) => {
        if (!cancelled) setLines(data);
      })
      .catch(() => {
        if (!cancelled) setLines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [partId]);

  return (
    <Card elevation={2}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <Inventory2OutlinedIcon fontSize="small" color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Materials
          </Typography>
          {lines && (
            <Typography variant="caption" color="text.secondary">
              ({lines.length} item{lines.length === 1 ? '' : 's'}, per unit)
            </Typography>
          )}
        </Box>

        {lines === null ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        ) : lines.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No materials on this part&apos;s BOM.
          </Typography>
        ) : (
          <List dense disablePadding>
            {lines.map((line, idx) => {
              const childPartId = line.child_part?.id;
              // Whole-order draw: ceil for discrete stock (a strip you can't cut
              // a fraction of), else the fractional total. Shown so "0.05 strips
              // per unit" is never the only number on the floor.
              const jobNeeds =
                orderQuantity && orderQuantity > 0
                  ? line.consume_whole_units
                    ? Math.ceil(orderQuantity * line.quantity)
                    : orderQuantity * line.quantity
                  : null;
              const text = (
                <ListItemText
                  primary={
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {line.child_part?.part_name ?? 'Unknown item'}
                    </Typography>
                  }
                  secondary={
                    <>
                      <Typography variant="caption" color="text.secondary" component="span" sx={{ display: 'block' }}>
                        {line.quantity} {line.unit} / part
                        {line.consume_whole_units ? ' · whole units' : ''}
                      </Typography>
                      {jobNeeds !== null && (
                        <Typography variant="caption" color="text.primary" component="span" sx={{ display: 'block', fontWeight: 500 }}>
                          This job needs {formatMatQty(jobNeeds)} {line.unit}
                        </Typography>
                      )}
                    </>
                  }
                />
              );
              // Each BOM material is a real part — link the row to its detail
              // page. Rows without a resolvable child part stay non-clickable.
              return childPartId ? (
                <ListItemButton
                  key={line.id}
                  component={NextLink}
                  href={`/dashboard/${companyId}/parts/${childPartId}`}
                  divider={idx < lines.length - 1}
                  sx={{ alignItems: 'flex-start', py: 1 }}
                >
                  {text}
                </ListItemButton>
              ) : (
                <ListItem
                  key={line.id}
                  divider={idx < lines.length - 1}
                  sx={{ alignItems: 'flex-start', py: 1 }}
                >
                  {text}
                </ListItem>
              );
            })}
          </List>
        )}
      </CardContent>
    </Card>
  );
}
