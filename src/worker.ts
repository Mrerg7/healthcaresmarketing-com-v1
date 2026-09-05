/**
 * Edge Worker: permanent URL canonicalization + real 404s for soft-404 crawl targets.
 * Addresses GSC: "Duplicate without user-selected canonical" and "Soft 404".
 */
const CANONICAL_HOST = 'healthcaresmarketing.com';

interface Env {
  ASSETS: Fetcher;
}

function canonicalLocation(requestUrl: URL, pathname: string): string {
  const next = new URL(requestUrl.toString());
  next.protocol = 'https:';
  next.hostname = CANONICAL_HOST;
  next.pathname = pathname;
  next.hash = '';
  return next.toString();
}

async function serveNotFound(env: Env, origin: string): Promise<Response> {
  // Under force-trailing-slash, /404/ is the asset URL for 404.html.
  const page = await env.ASSETS.fetch(new URL('/404/', origin).toString());
  const headers = new Headers(page.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  return new Response(page.body, {
    status: 404,
    statusText: 'Not Found',
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

    // /404 and /404.html must never be 200 — that is a classic soft 404.
    // Handle before slash/host redirects so crawlers get a real 404 status.
    if (/^\/404(\.html)?\/?$/i.test(url.pathname)) {
      return serveNotFound(env, url.origin);
    }

    let pathname = url.pathname;
    let needsRedirect = false;

    if (proto === 'http' || url.protocol === 'http:') {
      needsRedirect = true;
    }

    if (host === `www.${CANONICAL_HOST}` || host.endsWith('.workers.dev')) {
      needsRedirect = true;
    }

    // Collapse index.html / bare /index onto / with a permanent redirect (not asset 307).
    if (/^\/index(\.html)?\/?$/i.test(pathname)) {
      pathname = '/';
      needsRedirect = true;
    }

    // Do not invent trailing-slash 301s for unknown paths (that delays real 404s).
    // Existing HTML slash fixes come from ASSETS and are upgraded 307→301 below.

    if (needsRedirect) {
      return Response.redirect(canonicalLocation(url, pathname), 301);
    }

    const assetResponse = await env.ASSETS.fetch(request);

    // Promote Cloudflare asset HTML normalizations from temporary → permanent.
    if (assetResponse.status === 307 || assetResponse.status === 302) {
      const location = assetResponse.headers.get('Location');
      if (location) {
        const dest = new URL(location, `https://${CANONICAL_HOST}`);
        dest.protocol = 'https:';
        dest.hostname = CANONICAL_HOST;
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
      const canonicalPath = url.pathname === '' ? '/' : url.pathname;
      headers.set(
        'Link',
        `<https://${CANONICAL_HOST}${canonicalPath}>; rel="canonical"`,
      );
    }

    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
