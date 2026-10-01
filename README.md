# healthcaresmarketing.com

Modern, clean healthcare-marketing site built with **Astro 7** + **Tailwind CSS 4**, deployed on **Cloudflare Workers Static Assets** (free plan, no adapter).

## Stack

- Astro 7 (static output)
- Tailwind CSS 4 via `@tailwindcss/vite`
- `@astrojs/sitemap`
- Content Collections (ready)
- Cloudflare Images CDN for the primary visual (preconnect + preload + fetchpriority)
- Full Open Graph + Twitter cards + JSON-LD (WebSite, Organization/ProfessionalService, FAQPage)
- `robots.txt` + auto-generated sitemap
- Serverless API in the same Worker: `GET /api/health`, `POST /api/contact` (validated + honeypot, no extra product = free-plan safe)
- Security headers (HSTS, CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy) + immutable caching for `/_astro/*`

## Local development

```bash
npm install
npm run dev
```

## Build & Deploy (Cloudflare Workers Static Assets)

```bash
npm run build
# outputs pure static files to ./dist

# Deploy (requires wrangler logged in)
npm run deploy
# or
npx wrangler deploy
```

`wrangler.toml` serves Static Assets with a small Worker that 301-redirects `www` → apex and returns a real `404.html` for missing paths. The Worker also serves the `/api/*` endpoints (same deploy, no extra cost).

## Pages / sections (single-page, anchor-nav)

Header/nav, hero (visible H1 + dual CTA + trust signals), outcomes bar, filterable+searchable services, 4-step process, testimonials, insights hub (DA content), FAQ (details/summary + FAQPage schema), contact (form → `/api/contact` with mailto fallback), exit-intent checklist modal, light/dark toggle.

## Domain

Production target: **https://healthcaresmarketing.com**

CTA routes to: `sales@desertrich.com`

## Notes

- Fully static assets, edge-cached via Cloudflare; Worker only handles host canonicalization.
- Mobile-first, full-viewport image with brand, supporting line, CTA, and disclaimer.
- SEO: absolute canonical to apex HTTPS, meta description, custom 404, sitemap + robots.txt.
