/**
 * A read-only client for SAP S/4HANA's standard OData APIs.
 *
 * Chosen as the "minimum setup" route: it is plain HTTPS, so there is no SAP
 * SDK, no RFC library and no SAP GUI on the user's machine. All the SAP side
 * needs is the API activated in /IWFND/MAINT_SERVICE and a role allowing the
 * user to read it. The user's own SAP login is used — no technical user.
 *
 * This module only fetches rows. What happens to them is the same as for an
 * uploaded spreadsheet: column mapping, staging, validation, and only then
 * posting. A pull is a file that happens to arrive over the network.
 */

import { createHash } from 'node:crypto';
import { buildFilter } from '../../shared/sapFilter';
import type { SapConnection, SapExtract } from '../../shared/types';

export { DEFAULT_EXTRACT, buildFilter } from '../../shared/sapFilter';

export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Rows per request. Large enough to be quick, small enough not to time out the gateway. */
const PAGE_SIZE = 5000;
/** A runaway guard: a misconfigured filter should fail loudly, not read the whole ledger. */
const MAX_ROWS = 500_000;

export function buildUrl(conn: SapConnection, x: SapExtract, page: { top: number; skip: number }): string {
  const base = conn.baseUrl.trim().replace(/\/+$/, '');
  const path = x.servicePath.trim().replace(/^\/?/, '/').replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('$format', 'json');
  params.set('$top', String(page.top));
  if (page.skip) params.set('$skip', String(page.skip));
  const filter = buildFilter(x);
  if (filter) params.set('$filter', filter);
  if (conn.client.trim()) params.set('sap-client', conn.client.trim());
  if (conn.language.trim()) params.set('sap-language', conn.language.trim());
  // URLSearchParams writes spaces as "+", which SAP Gateway reads literally inside $filter.
  return `${base}${path}/${x.entitySet.trim()}?${params.toString().replace(/\+/g, '%20')}`;
}

/** OData v2 sends dates as "/Date(1717200000000)/"; everything downstream wants ISO. */
function plainValue(v: unknown): unknown {
  if (typeof v === 'string') {
    const m = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(v);
    if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  }
  return v;
}

/**
 * Flatten one entity to a row of scalar columns. Navigation properties and
 * `__metadata` are dropped — they are links, not data.
 */
function flatten(entity: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entity)) {
    if (k.startsWith('__') || k.startsWith('@')) continue;
    if (v !== null && typeof v === 'object') continue;
    row[k] = plainValue(v);
  }
  return row;
}

function parsePage(body: string): { rows: Record<string, unknown>[]; next: string | null } {
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    // Single sign-on gateways answer an unauthenticated API call with an HTML login page.
    if (/<html/i.test(body)) {
      throw new Error('SAP answered with a web page instead of data — usually a single sign-on '
        + 'login screen. This service needs to accept user and password (basic authentication); '
        + 'ask your SAP Basis team to allow it for the API.');
    }
    throw new Error(`SAP returned something that is not JSON: ${body.slice(0, 200)}`);
  }
  const results = json?.d?.results ?? json?.value ?? (Array.isArray(json?.d) ? json.d : null);
  if (!Array.isArray(results)) throw new Error('SAP response has no result rows (expected d.results or value).');
  return {
    rows: results.map(flatten),
    next: json?.d?.__next ?? json?.['@odata.nextLink'] ?? null,
  };
}

/** Turn an HTTP failure into something a cost engineer can act on. */
async function explain(res: Awaited<ReturnType<Fetcher>>, url: string): Promise<Error> {
  let detail = '';
  try {
    const body = await res.text();
    const j = JSON.parse(body);
    detail = j?.error?.message?.value ?? j?.error?.message ?? '';
  } catch { /* not JSON — the status says enough */ }
  const where = url.split('?')[0];
  const hint: Record<number, string> = {
    401: 'User or password was not accepted. Check them, and the client number.',
    403: 'You are logged in but not authorised for this API. Your SAP role needs read access to it.',
    404: `The service was not found at ${where}. It may not be activated — ask Basis to activate it in /IWFND/MAINT_SERVICE.`,
  };
  return new Error(`SAP ${res.status} ${res.statusText}. ${hint[res.status] ?? ''} ${detail}`.replace(/\s+/g, ' ').trim());
}

function authHeaders(conn: SapConnection, password: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Basic ${Buffer.from(`${conn.user}:${password}`).toString('base64')}`,
  };
}

async function getPage(fetcher: Fetcher, url: string, headers: Record<string, string>) {
  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(url, { headers });
  } catch (err) {
    const msg = (err as Error).message;
    // An on-premise server often uses a certificate from the company's own authority (or a self-signed one).
    if (/CERT|certificate|SSL|ERR_CERT/i.test(msg)) {
      throw new Error(`SAP at ${url.split('?')[0]} uses a certificate this PC does not trust (${msg}). `
        + 'Ask IT to install the company root certificate on Windows, or use the server HTTP port '
        + '(80 + instance number, e.g. :8000) if your network policy allows it.');
    }
    throw new Error(`Could not reach SAP at ${url.split('?')[0]}: ${msg}. `
      + 'Check the system URL and that you are on the company network or VPN.');
  }
  if (!res.ok) throw await explain(res, url);
  return parsePage(await res.text());
}

/** Fetch one row to prove the login and the service work, and show which fields it has. */
export async function testConnection(conn: SapConnection, password: string, x: SapExtract,
                                     fetcher: Fetcher): Promise<{ columns: string[]; sample: Record<string, unknown> | null }> {
  const page = await getPage(fetcher, buildUrl(conn, { ...x, postedFrom: null, wbsPrefix: '' }, { top: 1, skip: 0 }),
    authHeaders(conn, password));
  return { columns: Object.keys(page.rows[0] ?? {}), sample: page.rows[0] ?? null };
}

export interface PulledRows {
  /** The first request, without credentials — the batch's lineage. */
  url: string;
  filter: string;
  columns: string[];
  rows: Record<string, unknown>[];
  /** Content hash, so an unchanged pull is recognised the way an unchanged file is. */
  hash: string;
  bytes: number;
}

/**
 * Read every row matching the extract. Follows the server's own paging link
 * when it sends one, otherwise pages with $skip until a short page comes back.
 */
export async function pullRows(conn: SapConnection, password: string, x: SapExtract,
                               fetcher: Fetcher): Promise<PulledRows> {
  if (!conn.baseUrl.trim()) throw new Error('No SAP system URL set.');
  if (!conn.user.trim()) throw new Error('No SAP user set.');
  const headers = authHeaders(conn, password);
  const first = buildUrl(conn, x, { top: PAGE_SIZE, skip: 0 });
  const rows: Record<string, unknown>[] = [];

  let url: string | null = first;
  let skip = 0;
  while (url) {
    const page = await getPage(fetcher, url, headers);
    rows.push(...page.rows);
    if (rows.length > MAX_ROWS) {
      throw new Error(`More than ${MAX_ROWS.toLocaleString()} rows match — narrow the WBS prefix or the date.`);
    }
    if (page.next) {
      url = new URL(page.next, url).toString();
    } else if (page.rows.length === PAGE_SIZE) {
      skip += PAGE_SIZE;
      url = buildUrl(conn, x, { top: PAGE_SIZE, skip });
    } else {
      url = null;
    }
  }

  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const body = JSON.stringify(rows);
  return {
    url: first,
    filter: buildFilter(x),
    columns,
    rows,
    hash: createHash('sha256').update(body).digest('hex'),
    bytes: Buffer.byteLength(body),
  };
}
