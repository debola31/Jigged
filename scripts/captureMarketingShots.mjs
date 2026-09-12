/**
 * Re-shoot the three desktop marketing screenshots.
 *
 * WHY THIS EXISTS. The landing page's screenshots went stale in eight weeks — the sidebar
 * said "Inventory" after it was renamed to Storage, a retired notification bell was still
 * in frame, and one shot showed a customer literally called "XYZ Machine Shop". Nothing
 * caught it because nothing could: the shots were captured by hand and composited outside
 * the repo, so there was no way to re-take them and no way to tell they had drifted.
 *
 * The three DESKTOP shots are fully scriptable, so they live here. The three PHONE shots
 * are not: they are captured on a real iPhone with Jigged added to the Home Screen (so iOS
 * runs it standalone and there is no Safari toolbar in frame) and composited into a device
 * mockup by hand.
 *
 * USAGE
 *   1. Local Supabase must be running and hold the seed (`Vanguard Precision Works`).
 *      DO NOT run `supabase db reset` to get it: the local stack is shared between
 *      checkouts and a reset drops whatever unmerged migrations another one is holding.
 *   2. Build and serve the app: `pnpm build && pnpm start`.
 *   3. `node scripts/captureMarketingShots.mjs`
 *   4. `./scripts/optimizeMarketingImages.sh` to regenerate the WebP set.
 *
 * WHAT IT DOES ABOUT THE AI SHOT. The dashboard opens a fresh conversation, and an empty
 * chat box is the one thing the insights section must never show — a reader cannot judge a
 * text field, only an answer. So this seeds a thread with a realistic question, answer and
 * chart straight into `ai_chat_messages` (the same approach e2e/insights-chat.spec.ts
 * takes), then opens it from the history rail. No model is called and no worker is needed.
 *
 * Every figure in the seeded answer is invented for the screenshot and belongs to the
 * seeded demo company. If you change it, keep it to something the model could actually
 * produce — check api/services/ai/semantics.md, and note that per-operation cost actuals
 * are deferred, so a quoted-versus-actual comparison is NOT a claim this product can make.
 */
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const SUPABASE_URL = process.env.TEST_SUPABASE_URL || 'http://127.0.0.1:54321';
const SECRET = process.env.TEST_SUPABASE_SECRET_KEY;
const APP = process.env.CAPTURE_BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.CAPTURE_EMAIL || 'admin2@jigged.test';
const PASSWORD = process.env.CAPTURE_PASSWORD || 'jigged-dev-1234';
const OUT = 'public/screenshots';
const COMPANY = 'Vanguard Precision Works';
const THREAD_TITLE = 'Shipped by month';

if (!SECRET) {
  console.error(
    'TEST_SUPABASE_SECRET_KEY is not set. Get it from `supabase status -o env` and export it.'
  );
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

async function seedAnsweredQuestion() {
  const { data: company } = await admin
    .from('companies').select('id').eq('name', COMPANY).single();
  if (!company) throw new Error(`no company named "${COMPANY}" — is the seed loaded?`);
  const { data: access } = await admin
    .from('user_company_access').select('user_id').eq('company_id', company.id).limit(1).single();

  await admin.from('ai_chat_threads').delete().eq('title', THREAD_TITLE);
  const { data: thread, error } = await admin
    .from('ai_chat_threads')
    .insert({ company_id: company.id, created_by: access.user_id, title: THREAD_TITLE })
    .select('id').single();
  if (error) throw error;

  const { error: msgError } = await admin.from('ai_chat_messages').insert([
    {
      thread_id: thread.id, company_id: company.id, seq: 1, role: 'user',
      content: 'What did we ship each month this year?',
    },
    {
      thread_id: thread.id, company_id: company.id, seq: 2, role: 'assistant',
      content:
        'You shipped $486,200 across 118 jobs so far this year. March and September were the ' +
        'two strongest months, and the dip in July lines up with the shutdown week.',
      chart_config: {
        chart_type: 'bar',
        x_key: 'month', y_key: 'shipped', x_label: 'Month', y_label: 'Shipped',
        data: [
          { month: 'Jan', shipped: 41200 }, { month: 'Feb', shipped: 47800 },
          { month: 'Mar', shipped: 63400 }, { month: 'Apr', shipped: 52100 },
          { month: 'May', shipped: 58900 }, { month: 'Jun', shipped: 49700 },
          { month: 'Jul', shipped: 28600 }, { month: 'Aug', shipped: 55300 },
          { month: 'Sep', shipped: 61400 },
        ],
      },
      follow_ups: ['Which customer drove September?', 'How does that compare with last year?'],
    },
  ]);
  if (msgError) throw msgError;
  console.log(`seeded "${THREAD_TITLE}"`);
}

/** A folder of drawings named the way a customer's package actually arrives. */
function drawingFolder() {
  const dir = path.join(process.cwd(), '.marketing-drawings');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const src = 'e2e/fixtures/drawings';
  for (const [from, to] of [
    ['E2E-DRAW-1.dxf', '1011770.dxf'], ['E2E-DRAW-1.pdf', '1011770.pdf'],
    ['E2E-DRAW-2.dxf', '1011302.dxf'], ['E2E-WELDMENT.dxf', '1011845-WELDMENT.dxf'],
    ['E2E-PDFONLY.pdf', '1011516.pdf'],
  ]) fs.copyFileSync(path.join(src, from), path.join(dir, to));
  return dir;
}

await seedAnsweredQuestion();

const browser = await chromium.launch();
// 1440x900 at 2x — the same 2880x1800 the page's <picture> sources are cut from.
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
});
const page = await ctx.newPage();

await page.goto(`${APP}/login`);
await page.getByRole('button', { name: 'Sign In' }).waitFor({ timeout: 60_000 });
await page.getByLabel('Email').fill(EMAIL);
await page.getByLabel('Password').fill(PASSWORD);
await page.getByRole('button', { name: 'Sign In' }).click();
await page.waitForURL(/\/dashboard\//, { timeout: 60_000 });
const companyId = /\/dashboard\/([0-9a-f-]{36})/.exec(page.url())[1];

async function shot(name) {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png  ${Math.round(fs.statSync(`${OUT}/${name}.png`).size / 1024)} KB`);
}

// ── feature-job-status: the hero. Wants a FULL table — the shot it replaces showed four
//    rows in a grid sized for twenty-five, which reads as an empty product.
await page.goto(`${APP}/dashboard/${companyId}/jobs`);
await page.waitForTimeout(3000);
await shot('feature-job-status');

// ── feature-insights: the answered question, opened from the history rail.
await page.goto(`${APP}/dashboard/${companyId}`);
await page.waitForTimeout(4000);
await page.getByRole('button', { name: /Chat history/i }).click();
await page.waitForTimeout(1500);
await page.getByText(THREAD_TITLE, { exact: false }).first().click();
await page.waitForTimeout(3500);
await page.keyboard.press('Escape').catch(() => {});
await shot('feature-insights');

// ── feature-drawings: the sheet beside the rows it produced. 1011770 is the one group
//    that has BOTH a DXF and a PDF; the DXF-only rows render a note, not a drawing.
await page.goto(`${APP}/dashboard/${companyId}/parts/drawings`);
await page.waitForTimeout(2500);
await page.locator('input[webkitdirectory]').first().setInputFiles(drawingFolder());
await page.waitForTimeout(1500);
await page.getByRole('button', { name: /^Read \d+ files?$/i }).click();
await page.waitForTimeout(4000);
await page.getByRole('button', { name: /Open the drawing for 1011770/i }).first().click();
await page.waitForTimeout(4000);
await shot('feature-drawings');

fs.rmSync(path.join(process.cwd(), '.marketing-drawings'), { recursive: true, force: true });
await browser.close();
console.log('\nNow run ./scripts/optimizeMarketingImages.sh');
