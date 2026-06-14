// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Documentation site for Kundun-Agent, deployed to Cloudflare Pages as a static
// build (no adapter). English is the default locale (served under /en after the
// splash home redirect); Brazilian Portuguese lives under /pt-br.
export default defineConfig({
  site: 'https://mcp.wgmcode.com',
  // The default locale lives under /en (not the site root), so send bare "/" to
  // the English home. Astro emits this as a static redirect at build time.
  redirects: {
    '/': '/en/',
  },
  integrations: [
    starlight({
      title: 'Kundun-Agent',
      description:
        'Local-first MCP memory and codebase intelligence agent for AI coding agents.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/wgm-dev/kundun-agent',
        },
        {
          icon: 'npm',
          label: 'npm',
          href: 'https://www.npmjs.com/package/kundun-agent',
        },
      ],
      defaultLocale: 'en',
      locales: {
        en: { label: 'English' },
        'pt-br': { label: 'Português (Brasil)', lang: 'pt-BR' },
      },
      sidebar: [
        {
          label: 'Start here',
          translations: { 'pt-BR': 'Comece aqui' },
          items: [
            { label: 'Getting started', slug: 'getting-started' },
            { label: 'Install & MCP setup', slug: 'install' },
            { label: 'MCP integration', slug: 'mcp-integration' },
            { label: 'Web dashboard', slug: 'dashboard' },
          ],
        },
        {
          label: 'Features',
          translations: { 'pt-BR': 'Recursos' },
          items: [
            { label: 'Architecture', slug: 'architecture' },
            { label: 'CLI reference', slug: 'cli-reference' },
            { label: 'Configuration', slug: 'configuration' },
            { label: 'Scanner & indexing', slug: 'scanner-indexing' },
            { label: 'Search', slug: 'search' },
            { label: 'Memory engine', slug: 'memory-engine' },
            { label: 'Task engine', slug: 'task-engine' },
            { label: 'Cleanup', slug: 'cleanup' },
            { label: 'Security', slug: 'security' },
          ],
        },
      ],
    }),
  ],
});
