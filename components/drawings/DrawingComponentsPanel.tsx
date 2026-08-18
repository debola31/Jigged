'use client';

/**
 * The components a weldment's cut list lists, and the one number that makes them
 * useful.
 *
 * WHY A COST FIELD IS THE WHOLE POINT. A BOM line to a child with no cost basis
 * makes the PARENT unpriceable — NULL propagates up — so attaching materials
 * without prices takes a weldment that quotes today and stops it quoting. That is
 * arguably the more honest answer, since its cost genuinely is unknown, but it
 * cannot be a surprise. So the cost is asked for here, the consequence of leaving
 * it blank is spelled out, and a priceless material is created but NOT linked.
 *
 * A markup is not a substitute. `part_pricing_tiers` says what we CHARGE;
 * `part_procurement_tiers` says what we PAY, and a markup over an unknown cost is
 * still unknown. Nothing seeds a default, and nothing should — what a shop pays
 * for 8" x 4" tube is a fact only they have.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import InputAdornment from '@mui/material/InputAdornment';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { parentsBlockedBy, totalQuantity, type ComponentPlan } from '@/lib/drawingComponents';

interface Props {
  plan: ComponentPlan;
  onChange: (plan: ComponentPlan) => void;
  disabled: boolean;
}

export default function DrawingComponentsPanel({ plan, onChange, disabled }: Props) {
  if (plan.materials.length === 0 && plan.made.length === 0) return null;

  const blocked = parentsBlockedBy(plan);
  const totalUses = plan.materials.reduce((n, m) => n + m.usedBy.length, 0);

  const setMaterial = (key: string, patch: Partial<ComponentPlan['materials'][number]>) =>
    onChange({
      ...plan,
      materials: plan.materials.map((m) => (m.key === key ? { ...m, ...patch } : m)),
    });

  const setMade = (key: string, include: boolean) =>
    onChange({ ...plan, made: plan.made.map((m) => (m.key === key ? { ...m, include } : m)) });

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          What these are made of
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {totalUses} line{totalUses === 1 ? '' : 's'} on the drawings
          {plan.materials.length > 0 && ` · ${plan.materials.length} material${plan.materials.length === 1 ? '' : 's'}`}
          {plan.made.length > 0 && ` · ${plan.made.length} part${plan.made.length === 1 ? '' : 's'} to make`}
        </Typography>

        {plan.materials.length > 0 && (
          <Table size="small" sx={{ mb: plan.made.length > 0 ? 3 : 0 }}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Material</TableCell>
                <TableCell>How much</TableCell>
                <TableCell sx={{ width: 120 }}>Unit</TableCell>
                <TableCell sx={{ width: 190 }}>What you pay per unit</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {plan.materials.map((m) => (
                <TableRow key={m.key} data-testid="material-row">
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={m.include}
                      disabled={disabled}
                      onChange={(e) => setMaterial(m.key, { include: e.target.checked })}
                      inputProps={{ 'aria-label': `Include ${m.description}` }}
                    />
                  </TableCell>
                  <TableCell>{m.description}</TableCell>
                  <TableCell>
                    {/* The cut list orders LENGTHS, so this is the sum of
                        quantity x length — the number a cost is actually per. */}
                    <Typography variant="body2">{totalQuantity(m).toLocaleString()}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      across {new Set(m.usedBy.map((u) => u.stem)).size} part
                      {new Set(m.usedBy.map((u) => u.stem)).size === 1 ? '' : 's'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {/* Asked for, never guessed: these sheets print "1803.2" beside
                        a tube described in inches, and guessing the unit would
                        silently scale every cost by 25.4. */}
                    <TextField
                      size="small"
                      placeholder="mm"
                      disabled={disabled || !m.include}
                      value={m.unit ?? ''}
                      onChange={(e) => setMaterial(m.key, { unit: e.target.value || null })}
                      inputProps={{ 'aria-label': `Unit for ${m.description}` }}
                    />
                  </TableCell>
                  <TableCell>
                    <TextField
                      size="small"
                      type="number"
                      placeholder="—"
                      disabled={disabled || !m.include}
                      value={m.costPerUnit ?? ''}
                      onChange={(e) =>
                        setMaterial(m.key, {
                          costPerUnit: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      slotProps={{
                        input: {
                          startAdornment: <InputAdornment position="start">$</InputAdornment>,
                        },
                      }}
                      inputProps={{ 'aria-label': `Cost per unit for ${m.description}` }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {plan.made.length > 0 && (
          <>
            <Typography variant="subtitle2" gutterBottom>
              Parts named on the drawings that you make yourself
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
              {plan.made.map((m) => (
                <Chip
                  key={m.key}
                  label={`${m.description}${m.quantity > 1 ? ` ×${m.quantity}` : ''}`}
                  color={m.include ? 'primary' : 'default'}
                  variant={m.include ? 'filled' : 'outlined'}
                  onClick={disabled ? undefined : () => setMade(m.key, !m.include)}
                />
              ))}
            </Box>
            <Typography variant="caption" color="text.secondary">
              These get created as parts so the drawings have somewhere to live. They have no work on
              them yet, so anything using them cannot be costed until they do.
            </Typography>
          </>
        )}

        {/* The sentence the user is owed BEFORE they commit, naming the parents
            rather than saying "some things are incomplete". */}
        {blocked.size > 0 && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            <AlertTitle>
              {blocked.size} part{blocked.size === 1 ? '' : 's'} won&apos;t be quotable yet
            </AlertTitle>
            {[...blocked.entries()].map(([stem, { name, reasons }]) => (
              <Typography key={stem} variant="body2">
                <strong>{name}</strong> — waiting on {reasons.join(', ')}
              </Typography>
            ))}
            <Typography variant="body2" sx={{ mt: 1 }}>
              Give a material a cost, or untick it, and it stops holding its part back. A material
              you leave blank is still created — just not attached yet.
            </Typography>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
