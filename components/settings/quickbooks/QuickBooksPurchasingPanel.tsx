'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import posthog from 'posthog-js';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import BusyButton from '@/components/common/BusyButton';
import MissingFieldsNotice from '@/components/common/MissingFieldsNotice';
import QuickBooksUnreachableAlert from '@/components/quickbooks/QuickBooksUnreachableAlert';
import { useLoad } from '@/hooks/useLoad';
import { useUserRole } from '@/hooks/useUserRole';
import {
  QuickBooksError,
  checkQuickBooksPreferences,
  getQuickBooksPurchasingSetup,
  isQuickBooksUnreachable,
  listQuickBooksPurchaseAccounts,
  listQuickBooksPurchaseItems,
  setQuickBooksApAccount,
  setQuickBooksPurchaseItems,
  type PurchaseLineKind,
  type QuickBooksAccount,
  type QuickBooksPreferencesCheck,
  type QuickBooksProvider,
  type QuickBooksPurchaseItem,
  type QuickBooksPurchaseItemChoice,
  type QuickBooksPurchaseItemSetting,
  type QuickBooksPurchasingPreferences,
  type QuickBooksPurchasingSetup,
} from '@/utils/quickbooksAccess';

/**
 * Settings → QuickBooks → Purchasing: the QuickBooks item vendor POs post under, the
 * accounts-payable account (QuickBooks Online), and a check that QuickBooks takes POs at all.
 *
 * THE MOUNT READS JIGGED'S OWN ROWS AND NOTHING ELSE (QB1). `getQuickBooksPurchasingSetup` is a
 * database read; every QuickBooks read here — the items, the accounts, the preferences — is behind
 * a click, because for QuickBooks Desktop each one is a Web Connector round trip to the shop's PC.
 *
 * ONE GENERAL ITEM IS THE DEFAULT (founder decision, plan §2): one "QuickBooks item for purchases"
 * fills all three line kinds. Splitting parts, outside services and other purchases across their
 * own items is a secondary choice, and a stored split opens as one.
 *
 * Only an admin can change any of it — the routes refuse everyone else — so the write actions are
 * not drawn for anyone else, even though Settings is admin-only already.
 */

type ItemTarget = 'all' | PurchaseLineKind;

/** WHICH control is waiting. Only that one may say so (interaction-standards.md §5). */
type Pressed = `list:${ItemTarget}` | 'save' | 'ap:list' | 'ap:save' | 'check' | 'retry';

interface Picker {
  target: ItemTarget;
  items: QuickBooksPurchaseItem[];
  accounts: QuickBooksAccount[];
  mode: 'existing' | 'create';
  itemId: string;
  accountId: string;
}

type Problem =
  | { kind: 'unreachable'; message: string; code: string | null; retry: () => void }
  | { kind: 'refusal' | 'error'; message: string };

const KINDS: readonly PurchaseLineKind[] = ['part', 'outside_service', 'other'];

const KIND_TITLE: Record<PurchaseLineKind, string> = {
  part: 'Parts and material',
  outside_service: 'Outside services',
  other: 'Other purchases',
};

const ONE_ITEM_TITLE = 'QuickBooks item for purchases';

const DESKTOP_READ_WAIT =
  'Reading your items from QuickBooks on the shop computer. This takes a few seconds, and longer if QuickBooks was closed.';
const DESKTOP_WAIT =
  'QuickBooks Desktop answers from the shop computer, so this can take a few seconds — longer if QuickBooks was closed.';

/** Vendor POs can't be sent until every line kind has an item. The accounts-payable account is
 *  not counted: with exactly one in QuickBooks Online, the first send picks it up by itself. */
function needsPurchasingSetup(setup: QuickBooksPurchasingSetup): boolean {
  return setup.connected && setup.missing.some((key) => key.startsWith('item:'));
}

export default function QuickBooksPurchasingPanel({
  companyId,
  onSetupChange,
}: {
  companyId: string;
  /** Told after every read whether vendor POs still need their purchases item — the QuickBooks
   *  Desktop panel shows "Purchasing setup needed" beside its own setup step from it. */
  onSetupChange?: (needsSetup: boolean) => void;
}) {
  const { isAdmin } = useUserRole();
  // Held in a ref so the loader need not depend on a possibly inline callback (the useLoad onError pattern).
  const onSetupChangeRef = useRef(onSetupChange);
  useEffect(() => {
    onSetupChangeRef.current = onSetupChange;
  });

  const { data: setup, error: loadError, reload, refresh } = useLoad<QuickBooksPurchasingSetup>(
    async () => {
      const loaded = await getQuickBooksPurchasingSetup(companyId);
      onSetupChangeRef.current?.(needsPurchasingSetup(loaded));
      return loaded;
    },
    [companyId],
  );

  const [splitView, setSplitView] = useState<boolean | null>(null);
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [apChoices, setApChoices] = useState<QuickBooksAccount[] | null>(null);
  const [apChoice, setApChoice] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [check, setCheck] = useState<QuickBooksPreferencesCheck | null>(null);

  const busy = pressed !== null;
  const provider: QuickBooksProvider | null = setup?.provider ?? null;
  const isDesktop = provider === 'qbd';

  /** Start an action: clear what the last one said, unless this IS its retry (whose alert, and
   *  its pressed Try again, stay up until the answer comes). */
  const begin = (via: Pressed) => {
    setPressed(via);
    setNote(null);
    if (via !== 'retry') setProblem(null);
  };

  const fail = (err: unknown, retry: () => void) => {
    if (isQuickBooksUnreachable(err)) {
      setProblem({
        kind: 'unreachable',
        message: messageOf(err),
        code: err instanceof QuickBooksError ? (err.code ?? null) : null,
        retry,
      });
      return;
    }
    // A 4xx is a sentence the admin can act on ("That's the item Jigged's invoices post to…").
    const status = err instanceof QuickBooksError ? err.status : undefined;
    const shopFixable = status !== undefined && status >= 400 && status < 500;
    setProblem({ kind: shopFixable ? 'refusal' : 'error', message: messageOf(err) });
  };

  const chooseItem = async (target: ItemTarget, via: Pressed = `list:${target}`) => {
    begin(via);
    setApChoices(null);
    try {
      const { items, accounts } = await listQuickBooksPurchaseItems(companyId);
      const eligible = items.filter((i) => i.eligible);
      // A question with one answer is not asked: the only usable item, or the only account a new
      // one could post to, is picked for them. Saving still takes their click.
      setPicker({
        target,
        items,
        accounts,
        mode: eligible.length > 0 ? 'existing' : 'create',
        itemId: eligible.length === 1 ? eligible[0].id : '',
        accountId: accounts.length === 1 ? accounts[0].id : '',
      });
      setProblem(null);
    } catch (err) {
      fail(err, () => void chooseItem(target, 'retry'));
    } finally {
      setPressed(null);
    }
  };

  const saveItem = async (via: Pressed = 'save') => {
    if (!picker || !provider) return;
    const { target } = picker;
    const choice: QuickBooksPurchaseItemChoice =
      picker.mode === 'existing'
        ? { action: 'use_existing', qb_item_id: picker.itemId }
        : { action: 'create', qb_account_id: picker.accountId };
    begin(via);
    try {
      const saved = await setQuickBooksPurchaseItems(
        companyId,
        target === 'all' ? { allKinds: choice } : { byKind: { [target]: choice } },
      );
      posthog.capture('quickbooks purchase item chosen', {
        provider,
        setup_key: target === 'all' ? 'all_kinds' : `item:${target}`,
        action: choice.action,
      });
      const name = saved.items.find((i) => target === 'all' || i.line_kind === target)?.qb_name ?? null;
      setPicker(null);
      setProblem(null);
      setNote(savedItemNote(target, name));
      await refresh();
    } catch (err) {
      fail(err, () => void saveItem('retry'));
    } finally {
      setPressed(null);
    }
  };

  const chooseAp = async (via: Pressed = 'ap:list') => {
    begin(via);
    setPicker(null);
    try {
      const { ap_accounts } = await listQuickBooksPurchaseAccounts(companyId);
      if (ap_accounts.length === 1) {
        // One accounts-payable account is not a decision (docs/modules/quickbooks-desktop.md).
        const saved = await setQuickBooksApAccount(companyId, ap_accounts[0].id);
        setApChoices(null);
        setNote(
          `Uses ${saved.ap_account.qb_name ?? ap_accounts[0].full_name ?? 'it'}, the only accounts-payable account in QuickBooks Online.`,
        );
        await refresh();
      } else {
        setApChoices(ap_accounts);
        setApChoice('');
      }
      setProblem(null);
    } catch (err) {
      fail(err, () => void chooseAp('retry'));
    } finally {
      setPressed(null);
    }
  };

  const saveAp = async (via: Pressed = 'ap:save') => {
    if (!apChoice) return;
    begin(via);
    try {
      const saved = await setQuickBooksApAccount(companyId, apChoice);
      setApChoices(null);
      setProblem(null);
      setNote(`Saved. Vendor POs use ${saved.ap_account.qb_name ?? 'that account'}.`);
      await refresh();
    } catch (err) {
      fail(err, () => void saveAp('retry'));
    } finally {
      setPressed(null);
    }
  };

  const runCheck = async (via: Pressed = 'check') => {
    begin(via);
    try {
      const answer = await checkQuickBooksPreferences(companyId);
      setCheck(answer);
      setProblem(null);
      await refresh();
    } catch (err) {
      fail(err, () => void runCheck('retry'));
    } finally {
      setPressed(null);
    }
  };

  if (loadError) {
    return (
      <Alert
        severity="warning"
        action={
          <Button color="inherit" size="small" onClick={() => void reload()}>
            Try again
          </Button>
        }
      >
        We couldn&apos;t load the purchasing setup just now.
      </Alert>
    );
  }

  if (!setup) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  // Reconnect needed, or disconnected under us: the card above says so.
  if (!setup.connected || !provider) return null;

  const byKind = new Map(setup.items.map((i) => [i.line_kind, i]));
  const general = setup.one_item_for_all ? (setup.items[0] ?? null) : null;
  const split = splitView ?? (setup.items.length > 0 && !setup.one_item_for_all);

  const itemActions = (target: ItemTarget, chosen: boolean) =>
    !isAdmin ? null : picker?.target === target ? (
      <ItemPickerView
        picker={picker}
        onChange={(patch) => setPicker({ ...picker, ...patch })}
        onSave={() => void saveItem()}
        onCancel={() => setPicker(null)}
        locked={busy}
        saving={pressed === 'save'}
        isDesktop={isDesktop}
      />
    ) : (
      <BusyButton
        variant={chosen ? 'outlined' : 'contained'}
        size="small"
        onClick={() => void chooseItem(target)}
        disabled={busy}
        pending={pressed === `list:${target}`}
        pendingLabel="Reading items…"
        pendingDetail={isDesktop ? DESKTOP_READ_WAIT : undefined}
      >
        {chosen ? 'Change item' : 'Choose item'}
      </BusyButton>
    );

  const known: QuickBooksPurchasingPreferences | null = check ?? setup.preferences;

  return (
    <Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        Purchasing
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Vendor POs go to QuickBooks as purchase orders, under the item you choose here. Bills stay in
        QuickBooks — Jigged never creates one.
      </Typography>

      {problem?.kind === 'unreachable' && (
        <QuickBooksUnreachableAlert
          message={problem.message}
          code={problem.code}
          onRetry={problem.retry}
          busy={busy}
          retrying={pressed === 'retry'}
        />
      )}
      {problem && problem.kind !== 'unreachable' && (
        <Alert
          severity={problem.kind === 'refusal' ? 'warning' : 'error'}
          sx={{ mb: 2 }}
          onClose={() => setProblem(null)}
        >
          {problem.message}
        </Alert>
      )}
      {note && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNote(null)}>
          {note}
        </Alert>
      )}

      {!split ? (
        <SetupRow
          title={ONE_ITEM_TITLE}
          state={general ? 'done' : 'required'}
          description={
            general
              ? `${itemPhrase(general)} Used for parts and material, outside services and other purchases.`
              : setup.items.length > 0
                ? 'Parts, outside services and other purchases each have their own item now. Choose one to use for all of them.'
                : "Not chosen yet. Vendor POs can't be sent to QuickBooks until you choose one."
          }
        >
          {itemActions('all', Boolean(general))}
        </SetupRow>
      ) : (
        KINDS.map((kind) => {
          const chosen = byKind.get(kind);
          return (
            <SetupRow
              key={kind}
              title={KIND_TITLE[kind]}
              state={chosen ? 'done' : 'required'}
              description={chosen ? itemPhrase(chosen) : 'Not chosen yet.'}
            >
              {itemActions(kind, Boolean(chosen))}
            </SetupRow>
          );
        })
      )}
      {isAdmin && (
        <Button
          variant="text"
          size="small"
          sx={{ mb: 2 }}
          onClick={() => {
            setSplitView(!split);
            setPicker(null);
          }}
        >
          {split ? 'Use one item for everything' : 'Use different items for parts, outside services and other'}
        </Button>
      )}

      {provider === 'qbo' && (
        <SetupRow
          title="Accounts-payable account"
          state={setup.ap_account ? 'done' : 'optional'}
          description={
            setup.ap_account
              ? `${setup.ap_account.qb_name ?? 'Chosen'}.`
              : 'Not chosen yet. If QuickBooks Online has only one, Jigged uses it.'
          }
        >
          {isAdmin &&
            (apChoices === null ? (
              <BusyButton
                variant="outlined"
                size="small"
                onClick={() => void chooseAp()}
                disabled={busy}
                pending={pressed === 'ap:list'}
                pendingLabel="Reading accounts…"
              >
                {setup.ap_account ? 'Change account' : 'Choose account'}
              </BusyButton>
            ) : apChoices.length === 0 ? (
              <Alert severity="warning" onClose={() => setApChoices(null)}>
                QuickBooks Online has no accounts-payable account yet. Add one in QuickBooks (Chart of
                accounts → New → Accounts payable), then choose it here.
              </Alert>
            ) : (
              <Box sx={INSET}>
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Accounts-payable account"
                  value={apChoice}
                  onChange={(e) => setApChoice(e.target.value)}
                  disabled={busy}
                >
                  {apChoices.map((a) => (
                    <MenuItem key={a.id} value={a.id}>
                      {a.full_name ?? a.id}
                    </MenuItem>
                  ))}
                </TextField>
                <MissingFieldsNotice
                  title="Before you can save:"
                  items={apChoice ? [] : ['Choose the accounts-payable account vendor POs use.']}
                />
                <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 2 }}>
                  <BusyButton
                    variant="contained"
                    size="small"
                    onClick={() => void saveAp()}
                    disabled={busy || !apChoice}
                    pending={pressed === 'ap:save'}
                    pendingLabel="Checking it in QuickBooks…"
                  >
                    Use this account
                  </BusyButton>
                  <Button size="small" onClick={() => setApChoices(null)} disabled={busy}>
                    Cancel
                  </Button>
                </Stack>
              </Box>
            ))}
        </SetupRow>
      )}

      <SetupRow
        title="Purchase orders in QuickBooks"
        state={
          known?.purchase_orders_enabled === false
            ? 'required'
            : known?.purchase_orders_enabled === true && (isDesktop || known.custom_txn_numbers === true)
              ? 'done'
              : 'optional'
        }
        description={checkDescription(check, setup.preferences, provider)}
      >
        {check && check.warnings.length > 0 && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {check.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </Box>
          </Alert>
        )}
        {isAdmin && (
          <BusyButton
            variant="outlined"
            size="small"
            onClick={() => void runCheck()}
            disabled={busy}
            pending={pressed === 'check'}
            pendingLabel="Asking QuickBooks…"
            pendingDetail={isDesktop ? DESKTOP_WAIT : undefined}
          >
            Check QuickBooks
          </BusyButton>
        )}
      </SetupRow>

      {isDesktop && (
        <Typography variant="caption" color="text.secondary" display="block">
          QuickBooks Desktop takes PO numbers of up to 11 characters, which is why Jigged&apos;s PO numbering
          keeps to 11.
        </Typography>
      )}
      {!isAdmin && (
        <Typography variant="caption" color="text.secondary" display="block">
          An admin can change the purchasing setup.
        </Typography>
      )}
    </Box>
  );
}

// ───────────────────────── pieces ─────────────────────────

/** A neutral inset (design-system.md, "Callouts & insets"), from theme tokens. */
const INSET = { p: 2, borderRadius: 1, bgcolor: 'action.hover', border: 1, borderColor: 'divider' } as const;

/** One setup step, drawn like the QuickBooks Desktop panel's income-account step. A `group`
 *  named by its title, so its button is "the Choose item of Outside services" to assistive tech. */
function SetupRow({
  title,
  state,
  description,
  children,
}: {
  title: string;
  state: 'done' | 'required' | 'optional';
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Stack role="group" aria-label={title} direction="row" spacing={1.5} alignItems="flex-start" sx={{ mb: 2 }}>
      {state === 'done' ? (
        <CheckCircleIcon fontSize="small" color="success" sx={{ mt: 0.4 }} />
      ) : (
        <RadioButtonUncheckedIcon
          fontSize="small"
          color={state === 'required' ? 'warning' : 'disabled'}
          sx={{ mt: 0.4 }}
        />
      )}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={500}>
          {title}
          {state === 'required' && (
            <Typography component="span" variant="body2" color="warning.main">
              {' '}— required
            </Typography>
          )}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: children ? 1 : 0 }}>
          {description}
        </Typography>
        {children}
      </Box>
    </Stack>
  );
}

function ItemPickerView({
  picker,
  onChange,
  onSave,
  onCancel,
  locked,
  saving,
  isDesktop,
}: {
  picker: Picker;
  onChange: (patch: Partial<Pick<Picker, 'mode' | 'itemId' | 'accountId'>>) => void;
  onSave: () => void;
  onCancel: () => void;
  /** Another action is in flight. Named for what it does to THESE controls — they are locked,
   *  not waiting; the button that was pressed is the one that says it is waiting. */
  locked: boolean;
  saving: boolean;
  isDesktop: boolean;
}) {
  const eligible = picker.items.filter((i) => i.eligible);
  const ineligible = picker.items.filter((i) => !i.eligible);
  const creating = picker.mode === 'create';
  const missing = creating
    ? picker.accountId
      ? []
      : ['Choose the account the new item posts to.']
    : picker.itemId
      ? []
      : ['Choose the item purchases post under.'];

  return (
    <Box sx={INSET}>
      <RadioGroup
        value={picker.mode}
        onChange={(e) => onChange({ mode: e.target.value === 'create' ? 'create' : 'existing' })}
      >
        <FormControlLabel
          value="existing"
          control={<Radio />}
          label="Use an item already in QuickBooks"
          disabled={locked || eligible.length === 0}
        />
        {!creating && (
          <TextField
            select
            fullWidth
            size="small"
            label="Item"
            value={picker.itemId}
            onChange={(e) => onChange({ itemId: e.target.value })}
            disabled={locked}
            sx={{ mb: 1 }}
          >
            {eligible.map((i) => (
              <MenuItem key={i.id} value={i.id}>
                {`${i.name ?? i.id} — posts to ${i.posting_account_name ?? 'its account'}`}
              </MenuItem>
            ))}
            {/* Listed, so an item they expected isn't simply missing, but never pickable: a
                purchase posted to income would book a cost as negative revenue. */}
            {ineligible.map((i) => (
              <MenuItem key={i.id} value={i.id} disabled>
                {`${i.name ?? i.id} — posts to ${i.posting_account_name ?? 'an account'}, which isn't an expense account`}
              </MenuItem>
            ))}
          </TextField>
        )}
        <FormControlLabel value="create" control={<Radio />} label="Create a new item posting to…" disabled={locked} />
        {creating && (
          <TextField
            select
            fullWidth
            size="small"
            label="Account it posts to"
            value={picker.accountId}
            onChange={(e) => onChange({ accountId: e.target.value })}
            disabled={locked}
          >
            {picker.accounts.map((a) => (
              <MenuItem key={a.id} value={a.id}>
                {a.full_name ?? a.id}
              </MenuItem>
            ))}
          </TextField>
        )}
      </RadioGroup>
      {eligible.length === 0 && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          No non-inventory or service item in QuickBooks posts to an expense or cost-of-goods-sold account
          yet, so create one here.
        </Typography>
      )}
      <MissingFieldsNotice title="Before you can save:" items={missing} />
      <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 2 }}>
        <BusyButton
          variant="contained"
          size="small"
          onClick={onSave}
          disabled={locked || missing.length > 0}
          pending={saving}
          pendingLabel={creating ? 'Creating it in QuickBooks…' : 'Checking it in QuickBooks…'}
          pendingDetail={isDesktop ? DESKTOP_WAIT : undefined}
        >
          {creating ? 'Create item' : 'Use this item'}
        </BusyButton>
        <Button size="small" onClick={onCancel} disabled={locked}>
          Cancel
        </Button>
      </Stack>
    </Box>
  );
}

// ───────────────────────── words ─────────────────────────

function itemPhrase(item: QuickBooksPurchaseItemSetting): string {
  return `“${item.qb_name ?? 'Chosen item'}”, posting to ${item.posting_account_name ?? 'its QuickBooks account'}.`;
}

function savedItemNote(target: ItemTarget, name: string | null): string {
  if (!name) return 'Saved.';
  return target === 'all'
    ? `Saved. Vendor POs post under “${name}”.`
    : `Saved. ${KIND_TITLE[target]} post under “${name}”.`;
}

/** What is known about QuickBooks taking POs: this visit's check, else the stored answer. The
 *  check's own warnings are listed separately, so they are not repeated here. */
function checkDescription(
  check: QuickBooksPreferencesCheck | null,
  stored: QuickBooksPurchasingPreferences | null,
  provider: QuickBooksProvider,
): string {
  if (check) {
    if (check.warnings.length > 0) return 'Checked just now. QuickBooks needs a change:';
    return ['Checked just now.', ...preferenceSentences(check, provider, 'now')].join(' ');
  }
  if (stored) {
    const when = formatCheckedAt(stored.checked_at);
    return [when ? `Last checked ${when}.` : 'Checked before.', ...preferenceSentences(stored, provider, 'then')].join(' ');
  }
  return provider === 'qbd'
    ? 'Check that purchase orders are turned on in QuickBooks Desktop.'
    : "Check that purchase orders are turned on in QuickBooks Online, and that it keeps Jigged's PO numbers.";
}

function preferenceSentences(
  prefs: QuickBooksPurchasingPreferences,
  provider: QuickBooksProvider,
  tense: 'now' | 'then',
): string[] {
  const out: string[] = [];
  const now = tense === 'now';
  if (prefs.purchase_orders_enabled === true) out.push(now ? 'Purchase orders are turned on.' : 'Purchase orders were turned on.');
  if (prefs.purchase_orders_enabled === false) out.push(now ? 'Purchase orders are turned off.' : 'Purchase orders were turned off.');
  // Desktop always takes Jigged's number, so only Online has an answer to give here.
  if (provider === 'qbo' && prefs.custom_txn_numbers === true) {
    out.push(now ? "QuickBooks keeps Jigged's PO numbers." : "QuickBooks kept Jigged's PO numbers.");
  }
  if (provider === 'qbo' && prefs.custom_txn_numbers === false) {
    out.push('Custom transaction numbers were off, so QuickBooks gave each PO its own number.');
  }
  return out;
}

function formatCheckedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong talking to QuickBooks.';
}
