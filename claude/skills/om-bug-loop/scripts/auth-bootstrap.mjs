#!/usr/bin/env node
/**
 * Reusable authenticated browser session for the chart lane.
 *
 * WHY IT IS SHAPED THIS WAY
 * -------------------------
 * 1. Auth is httpOnly cookies (orange-v2-backend, `createCookie` in
 *    src/utility/utils.ts: httpOnly + secure + sameSite strict). Page
 *    JavaScript cannot read `accessToken`/`refreshToken`, so an agent can
 *    neither copy a token out of localStorage nor be handed one. Capture has
 *    to happen at the BROWSER layer — that is what storageState is.
 * 2. Cookies ignore ports, so ONE state file authenticates every localhost dev
 *    server at once (:8080, :8081, …). The isolation boundary is the browser
 *    PROFILE, not the port.
 * 3. **Scripted password login is the primary path and it works.** The Turnstile
 *    widget lives ONLY on the signup tab (see the `scriptedLogin` header), and
 *    dev is configured with Cloudflare's official always-pass TEST key in both
 *    `orange-v2-backend/.env.local` (`TURNSTILE_SECRETKEY`) and
 *    `kiyotaka-frontend/.env` (`VITE_TURNSTILE_SITEKEY`); the real keys are
 *    backed up beside them as `.bak-turnstile-2026-09-09`. There is no bot
 *    check to defeat here, by configuration. If a REAL sitekey ever returns,
 *    this path is legitimately blocked and a human must use `--login`.
 * 4. **Refresh tokens ROTATE**, so an exported state is effectively single-use
 *    and dies in about a minute. Every agent therefore mints its OWN session
 *    with `--out <path>`; two agents sharing one export knock each other out.
 *    Do NOT "improve" this back into a shared state file.
 *
 * `--login` remains as the human fallback: a headed browser against a
 * persistent profile, for the day a real sitekey comes back.
 *
 * USAGE
 *   node auth-bootstrap.mjs --out /tmp/<ref>-state.json   # per-agent mint
 *   node auth-bootstrap.mjs --login     # fallback, headed, human signs in
 *   node auth-bootstrap.mjs --check     # status only (exit 1 if stale)
 *   node auth-bootstrap.mjs --base http://localhost:8081
 *
 * AGENTS consume their own state:
 *   const ctx = await browser.newContext({ storageState: OUT });
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const AUTH_DIR = join(HOME, '.claude/om-bug-loop/auth');
const STATE_PATH = join(AUTH_DIR, 'storage-state.json');
const PROFILE_DIR = join(AUTH_DIR, 'chrome-profile');

/**
 * Only these prove a real session. `auth` and `guestToken` are deliberately
 * NOT here: both are issued to signed-OUT visitors too, and treating `auth` as
 * proof is exactly how an earlier version of this script reported a successful
 * mint while the exported state was still Guest Mode.
 */
const SESSION_COOKIES = ['accessToken', 'refreshToken'];

/**
 * Reuse margin. Observed cookie TTL on this backend is ~30 minutes, so this
 * MUST stay well under that or every run re-mints. Five minutes buys a short
 * task; a long run should re-export mid-flight rather than assume.
 */
const FRESH_MARGIN_MS = 5 * 60 * 1000;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const BASE = val('--base', process.env.OM_CHART_BASE || 'http://localhost:8081');
const PW_ROOT = process.env.OM_PLAYWRIGHT_ROOT
  || [join(HOME, 'Documents/GitlabRepos/kiyotaka-frontend/package.json')].find(existsSync);

const log = (...a) => console.log(...a);
const die = (m, c = 1) => { console.error(`auth-bootstrap: ${m}`); process.exit(c); };
const pw = () => {
  if (!PW_ROOT) die('cannot locate playwright — set OM_PLAYWRIGHT_ROOT', 3);
  return createRequire(PW_ROOT)('playwright');
};

const OUT = val('--out', STATE_PATH);
const CREDS_PATH = join(AUTH_DIR, 'credentials.env');

/** Read at runtime, never logged, never passed as an argument. */
function readCreds() {
  let email = process.env.OM_DEV_EMAIL;
  let password = process.env.OM_DEV_PASSWORD;
  if ((!email || !password) && existsSync(CREDS_PATH)) {
    for (const line of readFileSync(CREDS_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*(OM_DEV_EMAIL|OM_DEV_PASSWORD)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const v = m[2].replace(/^["']|["']$/g, '');
      if (m[1] === 'OM_DEV_EMAIL') email ||= v; else password ||= v;
    }
  }
  return { email, password };
}

/**
 * Scripted login — the PRIMARY path, and the reason it must be per-agent:
 * refresh tokens ROTATE. An exported state is effectively single-use and dies
 * within about a minute (measured: worked at +20s and +60s, dead by +3min and
 * on every replay). Two agents sharing one export knock each other out, and
 * the symptom looks exactly like a flaky login. So every agent mints its own.
 *
 * CORRECTED 2026-09-09 (T63 round 3): **the LOGIN tab has no Turnstile at all.**
 * `AuthFormView.vue` mounts the widget inside a `field-collapse` that is only
 * `open` for `currentMode === 'signup'`, and the mount watcher calls
 * `removeTurnstile()` for every other mode. So the earlier probe finding
 * "widgets: 0, no cf-turnstile-response input at submit time" was **correct and
 * expected**, not a symptom — a login submit carries no token by design and
 * `auth.loginWithZkp` never asks for one. The dev always-pass TEST key
 * (`1x00000000000000000000AA`) still matters for the SIGNUP path only.
 *
 * THE ACTUAL BUG that made this script fail, and the reason no login POST was
 * ever issued: the submit control is
 * `[data-testid="login-signup-submit-btn"]`, and it is
 * `:disabled="!isFormValid || isLoading"`. **`el.click()` on a disabled button
 * is a silent no-op** — no event, no error, nothing to observe. The old
 * `button[type="submit"]`.or(role=button name=/^log in$/i).last() locator also
 * resolved to the wrong node: `/^log in$/i` matches the login *tab*
 * (`login-signup-tab-login-btn`), which is a plain button, so `.last()` picked
 * a tab or an interstitial control rather than the form's submit. Both are
 * fixed below: testid-scoped locators, and a wait for the button to actually
 * become enabled (which doubles as proof that Vue saw both field values).
 */
async function scriptedLogin() {
  const { email, password } = readCreds();
  if (!email || !password) {
    die(`no credentials. Create ${CREDS_PATH} (chmod 600):\n` +
        `  OM_DEV_EMAIL=you@example.com\n  OM_DEV_PASSWORD=...\n` +
        `Read at runtime, never logged.`, 2);
  }
  const { chromium } = pw();
  const b = await chromium.launch({ headless: true });
  try {
    const c = await b.newContext({ viewport: { width: 1900, height: 1000 } });
    const page = await c.newPage();
    await page.goto(`${BASE}/chart/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Controls report as "outside of the viewport" in headless, so Playwright's
    // actionability checks retry to timeout forever. DOM dispatch is what works.
    const domClick = async (loc, what) => {
      await loc.waitFor({ state: 'attached', timeout: 25_000 })
        .catch(() => die(`never found ${what}`, 5));
      await loc.evaluate((el) => el.click());
      await page.waitForTimeout(700);
    };
    // Vue's v-model listens for `input`; setting .value alone is invisible to it.
    const domFill = async (loc, v, what) => {
      await loc.waitFor({ state: 'attached', timeout: 25_000 })
        .catch(() => die(`never found ${what}`, 5));
      await loc.evaluate((el, x) => {
        el.value = x;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, v);
    };

    // `.tb-terminal` is icon-only with no accessible name: semantic locators and
    // natural-language `find` miss it entirely. Class selector only.
    await domClick(page.locator('.tb-terminal').first(), '.tb-terminal');
    const cont = page.locator('[data-testid="mobile-entry-continue-btn"]');
    if (await cont.count()) await domClick(cont.first(), 'Continue Anyway');

    // Scope EVERYTHING to the auth dialog. The page carries other submit
    // buttons and other "Log In" text, which is how the old locator went wrong.
    const form = page.locator('.auth-form-view');
    await form.waitFor({ state: 'attached', timeout: 25_000 })
      .catch(() => die('the auth dialog never appeared after the terminal button', 5));

    // The dialog opens in SIGNUP mode by default (AuthFormView props default
    // `initialMode: 'signup'`), so this tab click is required, not optional.
    await domClick(form.locator('[data-testid="login-signup-tab-login-btn"]'), 'Log In tab');

    // Scope to the login FORM, not the dialog. `ForgotPasswordView` is always
    // mounted inside `.auth-form-view` (only its `field-collapse` class
    // changes), so it contributes its own `input[type="email"]` EARLIER in DOM
    // order than the login form's. `.first()` on the dialog therefore filled
    // the forgot-password field, the login form's `email` ref stayed empty,
    // `isFormValid` stayed false and the submit button stayed disabled — with
    // no error anywhere. Anchor on the form that owns the submit button.
    const loginForm = form.locator('form:has([data-testid="login-signup-submit-btn"])');
    await domFill(loginForm.locator('input[type="email"]').first(), email, 'email field');
    await domFill(loginForm.locator('input[type="password"]').first(), password, 'password field');

    // Wait for the submit button to lose `disabled`. TextField validates on a
    // watcher over its modelValue, so this is the observable proof that both
    // dispatched `input` events reached Vue and both fields passed their rules.
    // Clicking while still disabled is the silent no-op that broke this script.
    const submit = loginForm.locator('[data-testid="login-signup-submit-btn"]');
    await submit.waitFor({ state: 'attached', timeout: 25_000 })
      .catch(() => die('never found the submit button', 5));
    const enabledBy = Date.now() + 15_000;
    let enabled = false;
    while (Date.now() < enabledBy) {
      enabled = await submit.evaluate((el) => !el.disabled);
      if (enabled) break;
      await page.waitForTimeout(250);
    }
    if (!enabled) {
      die('submit stayed disabled — the form never validated (credentials shape?)', 5);
    }
    await domClick(submit, 'Log In submit');

    const deadline = Date.now() + 30_000;
    let got = [];
    while (Date.now() < deadline) {
      got = (await c.cookies()).filter((x) => SESSION_COOKIES.includes(x.name));
      if (got.length) break;
      await page.waitForTimeout(500);
    }
    if (!got.length) {
      const err = await page.locator('[class*="error" i]').first().innerText().catch(() => '');
      die(`login produced no session cookie${err ? ` — page says: ${err.slice(0, 160)}` : ''}`, 4);
    }
    await c.storageState({ path: OUT });
    chmodSync(OUT, 0o600);
    log(`wrote ${OUT} (${got.map((x) => x.name).join(', ')})`);
  } finally { await b.close(); }
}

/** Names and expiry only — never values, so output is safe to paste anywhere. */
function describeState() {
  if (!existsSync(OUT)) return { exists: false, fresh: false, cookies: [] };
  let st;
  try { st = JSON.parse(readFileSync(OUT, 'utf8')); }
  catch { return { exists: true, fresh: false, corrupt: true, cookies: [] }; }
  const found = (st.cookies || []).filter((c) => SESSION_COOKIES.includes(c.name));
  const soonest = found.length
    ? Math.min(...found.map((c) => (c.expires > 0 ? c.expires * 1000 : 0)))
    : 0;
  return {
    exists: true,
    cookies: found.map((c) => ({ name: c.name, ttlMin: Math.round((c.expires * 1000 - Date.now()) / 60000) })),
    expiresAt: soonest ? new Date(soonest).toISOString() : null,
    fresh: found.length > 0 && soonest - Date.now() > FRESH_MARGIN_MS,
  };
}

/** Loads the exported state in a clean context and asserts it is NOT a guest. */
async function proveState() {
  const { chromium } = pw();
  const b = await chromium.launch({ headless: true });
  try {
    const c = await b.newContext({ storageState: OUT, viewport: { width: 1900, height: 1000 } });
    const p = await c.newPage();
    await p.goto(`${BASE}/chart/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await p.waitForTimeout(8_000);
    return await p.evaluate(() => ({
      guest: !!document.querySelector('.guest-pill') || /guest mode/i.test(document.body.innerText),
    }));
  } finally { await b.close(); }
}

async function exportFromProfile({ headed }) {
  const { chromium } = pw();
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !headed,
    viewport: { width: 1900, height: 1000 },
  });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${BASE}/chart/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    const waitMs = headed ? 8 * 60_000 : 25_000;
    if (headed) {
      log('\n  A browser window is open.');
      log('  Sign in there (open the Terminal, dismiss "Best on Desktop", Log In).');
      log('  Solve the Cloudflare check yourself — that is the whole point of this step.');
      log('  This window closes on its own once a session appears. Waiting up to 8 min …\n');
    }
    const deadline = Date.now() + waitMs;
    let got = [];
    while (Date.now() < deadline) {
      got = (await ctx.cookies()).filter((c) => SESSION_COOKIES.includes(c.name));
      if (got.length) break;
      await page.waitForTimeout(1000);
    }
    if (!got.length) {
      die(headed
        ? 'no session cookie appeared before the timeout — was the login completed?'
        : `profile holds no live session. Run once with --login:\n  node ${process.argv[1]} --login`, 4);
    }
    await ctx.storageState({ path: STATE_PATH });
    chmodSync(STATE_PATH, 0o600);
    log(`wrote ${STATE_PATH} (${got.map((c) => c.name).join(', ')})`);
  } finally { await ctx.close(); }
}

mkdirSync(AUTH_DIR, { recursive: true });

if (has('--check')) {
  const st = describeState();
  log(JSON.stringify({ statePath: STATE_PATH, base: BASE, profile: PROFILE_DIR, ...st }, null, 2));
  process.exit(st.fresh ? 0 : 1);
}

const before = describeState();
if (before.fresh && !has('--force') && !has('--login')) {
  log(`reusing existing session (expires ${before.expiresAt}); --force to re-export`);
  process.exit(0);
}

if (has('--login')) await exportFromProfile({ headed: true });
else await scriptedLogin();
const proof = await proveState();
if (proof.guest) die('exported state still renders Guest Mode — it does NOT authenticate', 6);
log('verified: the exported state authenticates (no guest pill)');
log(JSON.stringify({ statePath: OUT, ...describeState() }, null, 2));
