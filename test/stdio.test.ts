import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';

describe('stdio transport', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gsc-stdio-'));
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it('serves tools/list over stdin/stdout with logs only on stderr and no bearer token', async () => {
    // A throwaway key: listing tools makes no Google request.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = { type: 'service_account', client_email: 'bot@test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/node/index.ts', '--stdio'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(key), DATA_DIR: dataDir, LOG_LEVEL: 'debug' },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    // Anything on stdout that is not JSON-RPC (a stray log line) surfaces here as a parse error.
    const transportErrors: Error[] = [];
    transport.onerror = (e) => transportErrors.push(e);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('get_page_queries');
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    await client.close();

    expect(transportErrors).toEqual([]);
    expect(stderr).toContain('running on stdio');
  }, 30_000);
});
