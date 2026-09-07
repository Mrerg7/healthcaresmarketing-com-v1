/**
 * Edge Worker: one-hop host canonicalization + soft-404 prevention.
 *
 * Addresses GSC:
 * - "Page with redirect" — do not 301 same-host /index.html (Cloudflare
 *   html_handling redirects). Serve homepage aliases at 200 with apex canonical.
 * - "Alternate page with proper canonical tag" — HTML + Link header always
 *   point at https://healthcaresmarketing.com/
 * - Soft 404 — /404 paths return a real 404 with noindex
 */
const CANONICAL_HOST = 'healthcaresmarketing.com';
const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;
const HOME_CANONICAL = `${CANONICAL_ORIGIN}/`;

interface Env {
  ASSETS: Fetcher;
}

/** Collapse /index.html (and bare /index) when building an off-host redirect. */
function directoryPath(pathname: string): string {
  if (/^\/index(\.html)?\/?$/i.test(pathname)) {
    return '/';
  }
  if (pathname.endsWith('/index.html')) {
    const next = pathname.slice(0, -'index.html'.length);
    return next === '' ? '/' : next;
  }
  return pathname;
}

function isHomeAlias(pathname: string): boolean {
  return pathname === '/' || pathname === '' || /^\/index(\.html)?\/?$/i.test(pathname);
}

function isNotFoundPath(pathname: string): boolean {
  return /^\/404(\.html)?\/?$/i.test(pathname);
}

function offHostCanonicalLocation(requestUrl: URL, host: string, proto: string): string | null {
  const needsHttps = proto === 'http' || requestUrl.protocol === 'http:';
  const needsApex =
    host === `www.${CANONICAL_HOST}` || host.endsWith('.workers.dev');

  if (!needsHttps && !needsApex && host === CANONICAL_HOST) {
    return null;
  }

  const next = new URL(requestUrl.toString());
  next.protocol = 'https:';
  next.hostname = CANONICAL_HOST;
  next.pathname = directoryPath(requestUrl.pathname);
  next.hash = '';
  return next.toString();
}

async function serveNotFound(env: Env, origin: string): Promise<Response> {
  const page = await env.ASSETS.fetch(new URL('/404.html', origin).toString());
  const headers = new Headers(page.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  return new Response(page.body, {
    status: 404,
    statusText: 'Not Found',
    headers,
  });
}

async function serveHome(env: Env, origin: string): Promise<Response> {
  const page = await env.ASSETS.fetch(new URL('/index.html', origin).toString());
  const headers = new Headers(page.headers);
  headers.set('Link', `<${HOME_CANONICAL}>; rel="canonical"`);
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  return new Response(page.body, {
    status: page.status,
    statusText: page.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = (request.headers.get('host') ?? url.hostname).split(':')[0].toLowerCase();
    const proto = (
      request.headers.get('x-forwarded-proto') ??
      url.protocol.replace(':', '')
    ).toLowerCase();

    // Real 404 for soft-404 crawl targets — before host/path rewrites.
    if (isNotFoundPath(url.pathname)) {
      return serveNotFound(env, url.origin);
    }

    const offHost = offHostCanonicalLocation(url, host, proto);
    if (offHost) {
      return Response.redirect(offHost, 301);
    }

    // Homepage aliases: 200 + apex canonical (avoids GSC "Page with redirect").
    if (isHomeAlias(url.pathname)) {
      return serveHome(env, url.origin);
    }

    // Crawler convenience URL — rewrite at 200 (no redirect chain).
    if (url.pathname === '/sitemap.xml') {
      return env.ASSETS.fetch(new URL('/sitemap-index.xml', url.origin).toString());
    }

    const assetResponse = await env.ASSETS.fetch(request);

    // Any leftover temporary asset redirects → permanent apex Location.
    if (assetResponse.status === 307 || assetResponse.status === 302) {
      const location = assetResponse.headers.get('Location');
      if (location) {
        const dest = new URL(location, CANONICAL_ORIGIN);
        dest.protocol = 'https:';
        dest.hostname = CANONICAL_HOST;
        dest.pathname = directoryPath(dest.pathname);
        dest.hash = '';
        return Response.redirect(dest.toString(), 301);
      }
    }

    const contentType = assetResponse.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      return assetResponse;
    }

    const headers = new Headers(assetResponse.headers);

    if (assetResponse.status === 404) {
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      return new Response(assetResponse.body, {
        status: 404,
        statusText: assetResponse.statusText,
        headers,
      });
    }

    if (assetResponse.status === 200) {
      // Single-page site: every indexable HTML document canonicalizes to apex /.
      headers.set('Link', `<${HOME_CANONICAL}>; rel="canonical"`);
    }

    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
