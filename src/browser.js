import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.AUTODEMO_HOME || path.join(os.homedir(), '.autodemo');
export const VIEWPORT = { width: 1280, height: 720 };
export const DPR = 2;

// Playwright's own Chromium when it is downloaded, otherwise the Google Chrome already on the Mac
// (nothing to install).
export const engine = () => (fs.existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' });

const profileDir = (name) => path.join(HOME, 'profiles', name);

// With a profile: persistent context, so sign-ins survive between runs.
// Without: a throwaway context.
export async function launch({ profile, headless = true, viewport = VIEWPORT } = {}) {
  const opts = { ...engine(), headless, viewport, deviceScaleFactor: DPR, colorScheme: 'light', locale: 'en-US' };
  let ctx, browser;
  if (profile) {
    ctx = await chromium.launchPersistentContext(profileDir(profile), opts);
  } else {
    browser = await chromium.launch({ ...engine(), headless });
    ctx = await browser.newContext(opts);
  }
  // Recordings are single-tab: links that open a new tab open in place instead.
  await ctx.addInitScript(() => {
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[target="_blank"]');
      if (a) a.removeAttribute('target');
    }, true);
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return {
    ctx,
    page,
    close: async () => { await ctx.close().catch(() => {}); await browser?.close().catch(() => {}); },
  };
}

// Wait until a JS-heavy page has actually painted content (not just fired `load`).
export async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 20, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
}
