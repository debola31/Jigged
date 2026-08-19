'use client';

/**
 * Route a part by tapping stations, without saying how long any of them take.
 *
 * THE PROBLEM THIS SOLVES. Cycle and setup times are a consensus — the shop has
 * to agree them, sometimes measure them, sometimes argue about them. Which
 * stations a part goes through is recall: anyone who knows the part says "mill,
 * lathe, deburr, inspect" without pausing. Bundling the two meant the fast answer
 * waited on the slow one, and under time pressure that produces a typed-in cycle
 * time nobody believes — which is worse than a blank, because a made-up number
 * reaches a customer looking exactly like a real one.
 *
 * So this control asks only what someone can answer now. The part comes out
 * ROUTED, NOT COSTED, and that is a state the database agrees with: an operation
 * with no times counts as no cost basis, so nothing here can quote at $0.00.
 *
 * ## The line, and why it runs off the edge
 *
 * This sits inside an expanded row of a thirty-one row table, so height is the
 * scarce thing — a grouped palette pushed the parts list off screen. One line
 * that bleeds right keeps the table visible, and paired with most-used-first
 * ordering the common route never scrolls at all: you scroll INTO the long tail,
 * which is where a rare station belongs.
 *
 * Horizontal scroll alone would strand a mouse user, so there are three ways in —
 * the arrows, the search box, and the arrow keys with Enter once the box has
 * focus.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';

import { getWorkCentersForRouting } from '@/utils/workCentersAccess';
import { getWorkCenterUsage } from '@/utils/workCenterUsageAccess';
import type { OperationRowData } from '@/components/routings/RoutingOperationRow';

interface Station {
  id: string;
  name: string;
  kind: 'internal' | 'external';
  laborRate: number | null;
  vendorName: string | null;
  uses: number;
}

interface Props {
  companyId: string;
  /** The route as operations. Times stay null — that is the point. */
  value: OperationRowData[];
  onChange: (next: OperationRowData[]) => void;
  disabled?: boolean;
  /** Labels the part being routed, for screen readers and the empty state. */
  subject?: string;
}

const newTempId = () => `tmp-${Math.random().toString(36).slice(2)}`;

export default function StationStrip({
  companyId,
  value,
  onChange,
  disabled = false,
  subject,
}: Props) {
  const [stations, setStations] = useState<Station[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [edges, setEdges] = useState({ left: false, right: false });

  const stripRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Two reads, not N: the catalogue and how often each has been used.
        const [centres, usage] = await Promise.all([
          getWorkCentersForRouting(companyId),
          getWorkCenterUsage(companyId),
        ]);
        if (cancelled) return;
        setStations(
          centres
            .map((c) => ({
              id: c.id,
              name: c.name,
              kind: c.kind === 'internal' ? ('internal' as const) : ('external' as const),
              laborRate: c.labor_rate,
              vendorName: c.vendor_name,
              uses: usage.get(c.id) ?? 0,
            }))
            // Most used first — the whole reason the strip stays short in practice.
            // Name breaks ties so a new shop, where everything is 0, is still
            // ordered rather than arbitrary.
            .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)),
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load stations.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const visible = useMemo(() => {
    if (!stations) return [];
    const q = query.trim().toLowerCase();
    if (!q) return stations;
    return stations
      .filter((s) => s.name.toLowerCase().includes(q))
      // A name that STARTS with what was typed is what they meant.
      .sort((a, b) => {
        const as = a.name.toLowerCase().startsWith(q);
        const bs = b.name.toLowerCase().startsWith(q);
        if (as !== bs) return as ? -1 : 1;
        return b.uses - a.uses;
      });
  }, [stations, query]);

  const readEdges = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft < max - 2 });
  }, []);

  useEffect(() => {
    readEdges();
    window.addEventListener('resize', readEdges);
    return () => window.removeEventListener('resize', readEdges);
  }, [readEdges, visible.length]);

  const add = (s: Station) => {
    onChange([
      ...value,
      {
        tempId: newTempId(),
        workCenterId: s.id,
        workCenterName: s.name,
        workCenterKind: s.kind,
        vendorName: s.vendorName,
        // The whole point: no times, no rate override, no instructions.
        setupMinutes: null,
        cycleMinutesPerUnit: null,
        laborRateOverride: null,
        workCenterLaborRate: s.laborRate,
        externalUnitPrice: null,
        instructions: null,
      } as OperationRowData,
    ]);
    // Reset the search after each add — the next station is a fresh question, and
    // a stale filter means the following tap lands in a list nobody asked for.
    setQuery('');
    setCursor(0);
    stripRef.current?.scrollTo({ left: 0 });
  };

  const removeAt = (i: number) => onChange(value.filter((_, n) => n !== i));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setQuery('');
      setCursor(0);
      return;
    }
    if (visible.length === 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % visible.length);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + visible.length) % visible.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(visible[Math.min(cursor, visible.length - 1)]);
    }
  };

  const nudge = (dir: -1 | 1) => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.7), behavior: 'smooth' });
  };

  if (error) {
    return (
      <Typography variant="body2" color="error">
        {error}
      </Typography>
    );
  }
  if (!stations) {
    return <CircularProgress size={20} />;
  }
  if (stations.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No work centres yet. Add one under Work Centers and it will appear here.
      </Typography>
    );
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: { xs: 'wrap', md: 'nowrap' } }}>
        <TextField
          size="small"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
            stripRef.current?.scrollTo({ left: 0 });
          }}
          onKeyDown={onKeyDown}
          placeholder="Find a station"
          disabled={disabled}
          sx={{ width: { xs: '100%', md: 200 }, flex: 'none' }}
          inputProps={{ 'aria-label': `Search work centres${subject ? ` for ${subject}` : ''}` }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />

        <Box sx={{ position: 'relative', flex: 1, minWidth: 0, width: '100%' }}>
          <Box
            ref={stripRef}
            onScroll={readEdges}
            role="group"
            aria-label="Work centres, most used first"
            sx={{
              display: 'flex',
              gap: 0.75,
              overflowX: 'auto',
              py: 0.25,
              scrollbarWidth: 'thin',
              '&::-webkit-scrollbar': { height: 6 },
              '&::-webkit-scrollbar-thumb': {
                backgroundColor: 'rgba(255,255,255,0.22)',
                borderRadius: 3,
              },
            }}
          >
            {visible.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic', py: 1 }}>
                No station called “{query.trim()}”.
              </Typography>
            ) : (
              visible.map((s, i) => {
                const focused = query.trim().length > 0 && i === cursor;
                return (
                  <Button
                    key={s.id}
                    onClick={() => add(s)}
                    disabled={disabled}
                    data-testid="station-option"
                    sx={{
                      flex: 'none',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      textTransform: 'none',
                      whiteSpace: 'nowrap',
                      px: 1.25,
                      py: 0.6,
                      lineHeight: 1.25,
                      border: 1,
                      borderColor: focused ? 'primary.light' : 'divider',
                      backgroundColor: focused ? 'action.selected' : 'transparent',
                      color: 'text.primary',
                    }}
                  >
                    <Box component="span" sx={{ fontSize: '0.87rem', fontWeight: 500 }}>
                      {s.name}
                    </Box>
                    <Box
                      component="span"
                      sx={{
                        fontSize: '0.7rem',
                        color: s.kind === 'internal' ? 'text.secondary' : 'secondary.light',
                      }}
                    >
                      {s.kind === 'internal'
                        ? s.laborRate != null
                          ? `$${s.laborRate}/hr`
                          : 'no rate set'
                        : `outside${s.vendorName ? ` · ${s.vendorName}` : ''}`}
                    </Box>
                  </Button>
                );
              })
            )}
          </Box>

          {/* A fade, not a hard cut — "there is more" felt rather than read, and
              only on the side where there actually is more. */}
          {(['left', 'right'] as const).map((side) => (
            <Box
              key={side}
              aria-hidden
              sx={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                [side]: 0,
                width: 44,
                pointerEvents: 'none',
                opacity: edges[side] ? 1 : 0,
                transition: 'opacity 150ms',
                background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, rgba(17,20,57,0.95), rgba(17,20,57,0))`,
              }}
            />
          ))}
          {(['left', 'right'] as const).map((side) => (
            <IconButton
              key={side}
              size="small"
              onClick={() => nudge(side === 'left' ? -1 : 1)}
              aria-label={`Scroll stations ${side}`}
              sx={{
                position: 'absolute',
                top: '50%',
                [side]: 2,
                transform: 'translateY(-50%)',
                opacity: edges[side] ? 1 : 0,
                pointerEvents: edges[side] ? 'auto' : 'none',
                transition: 'opacity 150ms',
                backgroundColor: 'background.paper',
                border: 1,
                borderColor: 'divider',
              }}
            >
              {side === 'left' ? (
                <ChevronLeftIcon fontSize="small" />
              ) : (
                <ChevronRightIcon fontSize="small" />
              )}
            </IconButton>
          ))}
        </Box>
      </Box>

      {/* The route itself. */}
      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75, mt: 1.5 }}>
        {value.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
            No stations yet — {subject ? `${subject} will be` : 'this part will be'} filed, not
            costed.
          </Typography>
        ) : (
          value.map((op, i) => (
            <Box
              key={op.tempId}
              data-testid="route-step"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.75,
                pl: 1,
                pr: 0.25,
                py: 0.4,
                border: 1,
                borderColor: op.workCenterKind === 'internal' ? 'primary.main' : 'secondary.main',
                borderRadius: 1,
                backgroundColor: 'action.hover',
              }}
            >
              <Box
                component="span"
                sx={{
                  display: 'grid',
                  placeItems: 'center',
                  width: 19,
                  height: 19,
                  borderRadius: '50%',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  backgroundColor:
                    op.workCenterKind === 'internal' ? 'primary.main' : 'secondary.main',
                  color: 'primary.contrastText',
                }}
              >
                {i + 1}
              </Box>
              <Box component="span" sx={{ fontSize: '0.87rem' }}>
                {op.workCenterName}
              </Box>
              <IconButton
                size="small"
                onClick={() => removeAt(i)}
                disabled={disabled}
                aria-label={`Remove ${op.workCenterName}`}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Box>
          ))
        )}
        {value.length > 0 && (
          <Button size="small" onClick={() => onChange([])} disabled={disabled}>
            Clear
          </Button>
        )}
      </Box>
    </Box>
  );
}
