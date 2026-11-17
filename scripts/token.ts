// Token admin CLI. Calls /admin/tokens on a running server; reads ADMIN_TOKEN from the environment.
//   npm run token -- create --url <base> --name <name> [--ttl-days 90] [--sites https://a/,sc-domain:b]
//   npm run token -- list   --url <base>
//   npm run token -- rotate --url <base> --id <id> [--ttl-days 90] [--grace-minutes 0]
//   npm run token -- revoke --url <base> --id <id>
import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    name: { type: 'string' },
    id: { type: 'string' },
    'ttl-days': { type: 'string' },
    'grace-minutes': { type: 'string' },
    sites: { type: 'string' },
  },
});

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const adminToken = process.env.ADMIN_TOKEN ?? fail('Set ADMIN_TOKEN in the environment');
const base = values.url?.replace(/\/+$/, '') ?? fail('Missing --url <base>, e.g. https://gsc-mcp.example.com');
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const need = (v: string | undefined, flag: string) => v ?? fail(`Missing ${flag}`);

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/admin/tokens${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) fail(`${res.status} ${text}`);
  process.stdout.write(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
}

const command = positionals[0];
switch (command) {
  case 'create':
    await call('POST', '', {
      name: need(values.name, '--name'),
      ttlDays: num(values['ttl-days']),
      allowedSites: values.sites?.split(',').map((s) => s.trim()).filter(Boolean),
    });
    break;
  case 'list':
    await call('GET', '');
    break;
  case 'rotate':
    await call('POST', `/${encodeURIComponent(need(values.id, '--id'))}/rotate`, {
      ttlDays: num(values['ttl-days']),
      graceMinutes: num(values['grace-minutes']),
    });
    break;
  case 'revoke':
    await call('DELETE', `/${encodeURIComponent(need(values.id, '--id'))}`);
    break;
  default:
    fail('Usage: npm run token -- create|list|rotate|revoke --url <base> [...] (see scripts/token.ts)');
}
