#!/usr/bin/env node
/**
 * Command Code usage - how much of the plan is left.
 *
 * Reads the three quota windows Command Code reports (5-hour, weekly, monthly)
 * and prints them. Zero dependencies, Node 18+, no network call except to the
 * Command Code API, no writes anywhere.
 *
 *   node cc-usage.mjs           # the panel
 *   node cc-usage.mjs --json    # the same numbers, machine-readable
 *
 * Credential: COMMAND_CODE_API_KEY (or COMMANDCODE_API_KEY / CMD_API_KEY), else
 * the login the Command Code CLI already stored at ~/.commandcode/auth.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API_BASE = (process.env.COMMAND_CODE_API_BASE || 'https://api.commandcode.ai').replace(/\/+$/, '');
const TIMEOUT_MS = 15000;

// The API reports what a window has *used*; the size of the window is a property
// of the plan. `windowLimits.<window>.cap` normally carries it, and this table is
// only the fallback for when it does not - so keep it in step with the plans.
const PLANS = {
  'individual-go': { name: 'Go', monthly: 10, fiveHour: 3, weekly: 6 },
  'individual-goat': { name: 'GOAT', monthly: 70, fiveHour: 14, weekly: 35 },
  'individual-pro': { name: 'Pro', monthly: 80, fiveHour: 16, weekly: 40 },
  'individual-max-10x': { name: 'Max 10x', monthly: 150, fiveHour: 45, weekly: 90 },
  'individual-max-20x': { name: 'Max 20x', monthly: 300, fiveHour: 90, weekly: 180 },
  'teams-pro': { name: 'Team Pro', monthly: 40, fiveHour: 12, weekly: 24 },
};

/* --------------------------------------------------------------- credentials */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function resolveCredential(env = process.env) {
  for (const name of ['COMMAND_CODE_API_KEY', 'COMMANDCODE_API_KEY', 'CMD_API_KEY']) {
    const value = env[name];
    if (value && value.trim()) return { apiKey: value.trim(), source: `$${name}` };
  }
  const file = path.join(os.homedir(), '.commandcode', 'auth.json');
  const doc = readJson(file);
  if (doc && typeof doc.apiKey === 'string' && doc.apiKey.trim()) {
    return { apiKey: doc.apiKey.trim(), source: file };
  }
  return null;
}

/* ------------------------------------------------------------------ the API */

async function apiGet(route, apiKey, query = {}) {
  const url = new URL(API_BASE + route);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: abort.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail = body?.error?.message || body?.message || text.slice(0, 200) || res.statusText;
      throw new Error(`${route} -> HTTP ${res.status}: ${detail}`);
    }
    if (!body || typeof body !== 'object') throw new Error(`${route} -> response was not JSON`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// A window that fails is not a reason to lose the whole panel; the caller decides
// what to do with the report. Returns { data } or { error }.
async function soft(promise) {
  try {
    return { data: await promise };
  } catch (error) {
    return { error: error.message };
  }
}

export async function collectUsage(apiKey, { orgId } = {}) {
  const whoami = await soft(apiGet('/alpha/whoami', apiKey, { limits: '1' }));
  const org = orgId || whoami.data?.org?.id || undefined;
  const scope = org ? { orgId: org } : {};

  const [credits, subscriptions] = await Promise.all([
    soft(apiGet('/alpha/billing/credits', apiKey, scope)),
    soft(apiGet('/alpha/billing/subscriptions', apiKey, scope)),
  ]);

  const since = subscriptions.data?.data?.currentPeriodStart;
  const summary = await soft(apiGet('/alpha/usage/summary', apiKey, { ...scope, since }));

  const errors = [whoami.error, credits.error, subscriptions.error, summary.error].filter(Boolean);
  if (errors.length === 4) throw new Error(`could not read usage:\n  - ${errors.join('\n  - ')}`);
  return { whoami: whoami.data, credits: credits.data, subscription: subscriptions.data, summary: summary.data, errors };
}

/* -------------------------------------------------------------- normalizing */

const asMoney = (value) => Math.max(0, Number(value) || 0);

export function normalize(raw, now = Date.now()) {
  const credits = raw.credits?.credits ?? {};
  const limits = raw.credits?.windowLimits ?? null;
  const subscription = raw.subscription?.data ?? null;
  const plan = PLANS[subscription?.planId] ?? null;
  const periodEnd = subscription?.currentPeriodEnd ? Date.parse(subscription.currentPeriodEnd) : null;

  // Two ways to answer "how big is the month": the plan's face value while the
  // subscription is active, otherwise what has been spent plus what is left.
  const monthlyLeft = asMoney(credits.monthlyCredits);
  const purchased = asMoney(credits.purchasedCredits);
  const free = asMoney(credits.freeCredits);
  const remaining = monthlyLeft + purchased + free;
  const planMonthly = subscription?.status === 'active' && plan ? plan.monthly : null;
  const pool = planMonthly !== null ? Math.max(planMonthly, monthlyLeft) + purchased + free : asMoney(raw.summary?.totalCost) + remaining;
  const spent = Math.max(0, pool - remaining);

  const window = (spec, fallbackCap) => {
    if (!spec) return null;
    const used = asMoney(spec.used);
    const cap = Number(spec.cap) || fallbackCap || 0;
    const resetAt = Number(spec.resetAt) || null;
    return {
      used,
      cap,
      percent: cap > 0 ? Math.min((used / cap) * 100, 100) : 0,
      remaining: Math.max(0, cap - used),
      resetAt,
      resetsInMs: resetAt ? Math.max(0, resetAt - now) : null,
      exceeded: Boolean(spec.exceeded),
    };
  };

  return {
    plan: plan ? plan.name : null,
    planId: subscription?.planId ?? null,
    status: subscription?.status ?? null,
    user: raw.whoami?.user?.userName ?? raw.whoami?.user?.name ?? null,
    org: raw.whoami?.org?.name ?? null,
    // `limited: false` means this account has no rolling windows at all - the
    // monthly pool is the whole story, and the two nulls below are the truth.
    limited: limits ? Boolean(limits.limited) : null,
    windows:
      limits?.limited === false
        ? { fiveHour: null, weekly: null }
        : { fiveHour: window(limits?.fiveHour, plan?.fiveHour), weekly: window(limits?.weekly, plan?.weekly) },
    monthly: {
      used: spent,
      cap: pool,
      remaining,
      percent: pool > 0 ? Math.min((spent / pool) * 100, 100) : 0,
      resetAt: periodEnd,
      resetsInMs: periodEnd ? Math.max(0, periodEnd - now) : null,
    },
    spend: {
      total: asMoney(raw.summary?.totalCost),
      perRequest: Number(raw.summary?.averageCost) > 0 ? Number(raw.summary.averageCost) : null,
      requests: Number(raw.summary?.totalCount) || null,
      failed: Number(raw.summary?.failedCount) || 0,
      successRate: Number.isFinite(Number(raw.summary?.successRate)) ? Number(raw.summary.successRate) : null,
    },
    errors: raw.errors ?? [],
  };
}

/* ---------------------------------------------------------------- rendering */

const ESC = String.fromCharCode(27);
const BLOCK = String.fromCharCode(9608); // full block
const SHADE = String.fromCharCode(9617); // light shade
// Eighth-blocks, low to high, so a bar can stop between two cells.
const EIGHTHS = [0x258f, 0x258e, 0x258d, 0x258c, 0x258b, 0x258a, 0x2589].map((c) => String.fromCharCode(c));
const AMBER = 70;
const RED = 90;

function paint(percent, text) {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return text;
  const code = percent >= RED ? 31 : percent >= AMBER ? 33 : 32;
  return `${ESC}[${code}m${text}${ESC}[0m`;
}

function bar(percent, width = 10) {
  const exact = (Math.max(0, Math.min(percent, 100)) / 100) * width;
  const full = Math.floor(exact);
  const partial = full < width ? EIGHTHS[Math.min(6, Math.round((exact - full) * 8) - 1)] || ' ' : '';
  return BLOCK.repeat(full) + partial + SHADE.repeat(Math.max(0, width - full - 1));
}

const money = (n) => `$${n.toFixed(2)}`;
// A per-request price is almost always under a cent, where two decimals read as $0.00.
const price = (n) => `$${n.toFixed(n >= 0.01 ? 2 : 4)}`;

function duration(ms) {
  if (!ms) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
}

function clock(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function render(view) {
  const lines = [];
  const who = [view.plan || view.planId || 'Command Code', view.user].filter(Boolean).join(' / ');
  lines.push(who + (view.status && view.status !== 'active' ? ` (${view.status})` : ''));

  const row = (label, window, missing) => {
    if (!window) {
      lines.push(`  ${label.padEnd(5)} ${missing}`);
      return;
    }
    const amount = window.cap > 0 ? `${money(window.remaining)} left of ${money(window.cap)}` : `${money(window.used)} used`;
    const reset = window.resetAt ? `resets ${clock(window.resetAt)} (in ${duration(window.resetsInMs)})` : 'no reset scheduled';
    const pct = `${window.percent.toFixed(0)}%`.padStart(4);
    lines.push(`  ${label.padEnd(5)} ${paint(window.percent, bar(window.percent))} ${pct}  ${amount.padEnd(30)} ${reset}`);
    if (window.exceeded) lines.push('        over the limit for this window');
  };

  row('5h', view.windows.fiveHour, 'not applicable on this plan');
  row('week', view.windows.weekly, 'not applicable on this plan');
  row('month', view.monthly, 'unknown');

  // The summary block is about the current billing period; the rows above are about
  // the quota windows. Different questions, so they get different lines.
  if (view.spend.requests || view.spend.total > 0) {
    const parts = [];
    if (view.spend.requests) parts.push(`${view.spend.requests} requests`);
    if (view.spend.failed) parts.push(`${view.spend.failed} failed`);
    if (view.spend.total > 0) parts.push(`${money(view.spend.total)} spent`);
    if (view.spend.perRequest) parts.push(`avg ${price(view.spend.perRequest)} each`);
    lines.push(`  period ${parts.join(' / ')}`);
    if (view.spend.perRequest) {
      lines.push(`         the month has room for about ${Math.floor(view.monthly.remaining / view.spend.perRequest)} more at that price`);
    }
  }
  for (const error of view.errors) lines.push(`  note: ${error}`);
  return lines.join('\n');
}

/* ---------------------------------------------------------------------- CLI */

async function main(argv) {
  const flags = new Set(argv.slice(2));
  if (flags.has('--help') || flags.has('-h')) {
    console.log('usage: cc-usage.mjs [--json]\n\nPrints the Command Code 5-hour, weekly and monthly quota windows.');
    return 0;
  }

  const credential = resolveCredential();
  if (!credential) {
    console.error(
      'No Command Code credential found. Either set COMMAND_CODE_API_KEY, or sign in with the Command Code CLI so that ~/.commandcode/auth.json exists.'
    );
    return 2;
  }

  let raw;
  try {
    raw = await collectUsage(credential.apiKey);
  } catch (error) {
    console.error(error.message);
    if (/HTTP 401|HTTP 403/.test(error.message)) {
      console.error('The credential was rejected - sign in again with the Command Code CLI, or check the key.');
    }
    return 1;
  }

  const view = normalize(raw);
  console.log(flags.has('--json') ? JSON.stringify(view, null, 2) : render(view));
  return 0;
}

// Only run when invoked directly, so the file can also be imported.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) main(process.argv).then((code) => process.exit(code));
