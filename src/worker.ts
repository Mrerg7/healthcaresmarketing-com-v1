/**
 * Edge Worker: canonicalization + security headers + tiny serverless API.
 * Free-plan safe: no KV/D1/R2, no external fetch, pure request handling.
 *
 * - www → apex 301, http → https, /index.html aliases served at 200
 * - Real 404 (no soft-404), noindex on 404
 * - Security headers on HTML, immutable caching on hashed assets
 * - POST /api/contact (validated, honeypot, size-capped) + GET /api/health
 */
const CANONICAL_HOST = 'healthcaresmarketing.com';
const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`;
const HOME_CANONICAL = `${CANONICAL_ORIGIN}/`;

interface Env {
  ASSETS: Fetcher;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_BODY_BYTES = 16 * 1024;

function directoryPath(pathname: string): string {
  if (/^\/index(\.html)?\/?$/i.test(pathname)) return '/';
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
  const needsApex = host === `www.${CANONICAL_HOST}` || host.endsWith('.workers.dev');
  if (!needsHttps && !needsApex && host === CANONICAL_HOST) return null;
  const next = new URL(requestUrl.toString());
  next.protocol = 'https:';
  next.hostname = CANONICAL_HOST;
  next.pathname = directoryPath(requestUrl.pathname);
  next.hash = '';
  return next.toString();
}

function securityHeaders(): Headers {
  const h = new Headers();
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()',
  );
  // Inline scripts/styles are used by Astro (is:inline) + Tailwind; allow inline but lock the rest down.
  h.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https://imagedelivery.net https://static.cloudflareinsights.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' https://cloudflareinsights.com https://static.cloudflareinsights.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' mailto:",
    ].join('; '),
  );
  return h;
}

function applyHtmlHeaders(base: Headers, opts: { noindex?: boolean } = {}): Headers {
  const headers = new Headers(base);
  const sec = securityHeaders();
  sec.forEach((v, k) => headers.set(k, v));
  headers.set('Link', `<${HOME_CANONICAL}>; rel="canonical"`);
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  if (opts.noindex) headers.set('X-Robots-Tag', 'noindex, nofollow');
  return headers;
}

function json(data: unknown, status = 200): Response {
  const headers = securityHeaders();
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

async function handleContact(request: Request): Promise<Response> {
  const len = Number(request.headers.get('content-length') ?? '0');
  if (len > MAX_BODY_BYTES) return json({ ok: false, error: 'Payload too large.' }, 413);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }

  const name = String(body['name'] ?? '').trim().slice(0, 120);
  const email = String(body['email'] ?? '').trim().slice(0, 160);
  const subject = String(body['subject'] ?? 'Growth plan request').trim().slice(0, 160);
  const message = String(body['message'] ?? '').trim().slice(0, 5000);
  const honeypot = String(body['company'] ?? '').trim();

  // Honeypot: pretend success so bots learn nothing.
  if (honeypot !== '') return json({ ok: true });

  if (name.length < 2) return json({ ok: false, error: 'Please add your name.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'Please add a valid work email.' }, 400);
  if (message.length < 10) return json({ ok: false, error: 'Tell us a little more (10+ characters).' }, 400);

  // Free-plan: no queue/email binding yet — structured log for `wrangler tail`.
  // Wire Resend/Email Sending later without changing the front-end contract.
  console.log(
    JSON.stringify({
      msg: 'contact_lead',
      name,
      email,
      subject,
      messageLen: message.length,
      page: String(body['page'] ?? '').slice(0, 300),
    }),
  );

  return json({ ok: true });
}

async function serveNotFound(env: Env, origin: string): Promise<Response> {
  const page = await env.ASSETS.fetch(new URL('/404.html', origin).toString());
  const headers = applyHtmlHeaders(page.headers, { noindex: true });
  return new Response(page.body, { status: 404, statusText: 'Not Found', headers });
}

async function serveHome(env: Env, origin: string): Promise<Response> {
  const page = await env.ASSETS.fetch(new URL('/index.html', origin).toString());
  const headers = applyHtmlHeaders(page.headers);
  return new Response(page.body, { status: page.status, statusText: page.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = (request.headers.get('host') ?? url.hostname).split(':')[0].toLowerCase();
    const proto = (
      request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
    ).toLowerCase();

    // Serverless API (same Worker, still free-plan: counts as requests, no extra product)
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ ok: true, host: CANONICAL_HOST, time: new Date().toISOString() });
    }
    if (url.pathname === '/api/contact' && request.method === 'POST') {
      // CORS: same-origin only; preflight not needed but handle gracefully
      return handleContact(request);
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ ok: false, error: 'Not found.' }, 404);
    }

    if (isNotFoundPath(url.pathname)) return serveNotFound(env, url.origin);

    const offHost = offHostCanonicalLocation(url, host, proto);
    if (offHost) return Response.redirect(offHost, 301);

    if (isHomeAlias(url.pathname)) return serveHome(env, url.origin);

    if (url.pathname === '/sitemap.xml') {
      return env.ASSETS.fetch(new URL('/sitemap-index.xml', url.origin).toString());
    }

    const assetResponse = await env.ASSETS.fetch(request);

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

    // Immutable caching for hashed build assets (perf: edge + browser cache)
    if (/^\/_astro\//.test(url.pathname)) {
      const headers = new Headers(assetResponse.headers);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    }

    const contentType = assetResponse.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return assetResponse;

    if (assetResponse.status === 404) {
      const headers = applyHtmlHeaders(assetResponse.headers, { noindex: true });
      return new Response(assetResponse.body, {
        status: 404,
        statusText: assetResponse.statusText,
        headers,
      });
    }

    if (assetResponse.status === 200) {
      const headers = applyHtmlHeaders(assetResponse.headers);
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    }

    return assetResponse;
  },
} satisfies ExportedHandler<Env>;
