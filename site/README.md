# Kundun-Agent documentation site

The documentation site for Kundun-Agent, published at **mcp.wgmcode.com**. Built
with [Astro Starlight](https://starlight.astro.build/); deployed as a static site
to Cloudflare Pages. English is the default locale; Brazilian Portuguese lives
under `/pt-br`.

Content is migrated from the repo's `docs/{en,pt-BR}/` Markdown into
`src/content/docs/{en,pt-br}/`.

## Local development

```bash
cd site
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in ./dist
npm run preview  # serve the built ./dist locally
```

Node 22+ is required (pinned via `.nvmrc`).

## Deploy to Cloudflare Pages

This site lives in the `site/` subfolder of the `kundun-agent` monorepo, so the
Pages project must point its **root directory** at `site`.

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**,
   and select the `kundun-agent` repository.
2. Build settings:
   - **Framework preset:** Astro
   - **Root directory:** `site`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist` (resolved as `site/dist`)
   - Ensure the project uses **Build system v2+** (needed for monorepo root
     directory). Node version comes from `site/.nvmrc` (22).
3. Deploy. The first build publishes to `<project>.pages.dev`.
4. **Custom domain:** Pages project → **Custom domains → Set up a custom domain**
   → `mcp.wgmcode.com`. Because `wgmcode.com` is already a zone on your
   Cloudflare account, Cloudflare creates the proxied CNAME automatically — just
   confirm. No nameserver changes needed.

Every push to the default branch that touches `site/` triggers a new deploy.
(Optionally enable Pages path filtering so unrelated commits to the agent code
don't rebuild the site.)

## Notes

- Purely static — **no** `@astrojs/cloudflare` adapter is needed.
- Bare `/` redirects to `/en/` (configured in `astro.config.mjs`).
- Search (Pagefind) and the sitemap are generated automatically at build time.
