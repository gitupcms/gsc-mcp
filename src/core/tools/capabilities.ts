import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GSC_READONLY_SCOPE } from '../google/client.js';
import { handle, READ_ONLY, type ToolDeps } from './common.js';

export function registerCapabilityTools(server: McpServer, { service, logger }: ToolDeps): void {
  server.registerTool(
    'get_capabilities',
    {
      title: 'Server capabilities',
      description:
        "What this server can do for you: its tools, the properties you may read, each one's URL inspections left today and any cooldown, " +
        'and the Google scope (read-only: Search Console data is never changed). Lists sites (usually from cache); no other Google call.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handle(logger, async (_args, { signal }) => {
      // shortcut: McpServer has no public tool list; this private field is checked by the tool-list test, so an SDK change shows up there.
      const registered = (server as unknown as { _registeredTools: Record<string, { title?: string; annotations?: { readOnlyHint?: boolean } }> })._registeredTools;
      const tools = Object.entries(registered).map(([name, t]) => ({ name, title: t.title, readOnly: t.annotations?.readOnlyHint === true }));
      let sites: string[] = [];
      let sitesError: unknown;
      try {
        sites = (await service.listSites(undefined, { signal })).value.map((s) => s.siteUrl!).filter(Boolean);
      } catch (err) {
        sitesError = { message: (err as Error).message };
      }
      const quota = service.quotaStatus(sites);
      return {
        scope: GSC_READONLY_SCOPE,
        readOnly: true,
        inspectionHistory: 'Fresh URL inspections are kept on this server for index_diff; no tool writes anything.',
        tools,
        sites: quota.sites.map((s) => ({
          siteUrl: s.siteUrl,
          urlInspectionsLeftToday: s.urlInspectionToday.remaining,
          urlInspectionDailyLimit: s.urlInspectionToday.limit,
          searchAnalyticsCooldownSeconds: s.searchAnalyticsCooldownSeconds,
          urlInspectionCooldownSeconds: s.urlInspectionCooldownSeconds,
        })),
        ...(sitesError ? { sitesError } : {}),
        dailyResetAt: quota.dailyResetAt,
        safetyFactor: quota.safetyFactor,
      };
    }),
  );
}
