/**
 * Edge Worker: canonicalize host, then serve Static Assets.
 * Fixes "Duplicate without user-selected canonical" (www vs apex both 200).
 */
const CANONICAL_HOST = 'healthcaresmarketing.com';

interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === `www.${CANONICAL_HOST}`) {
      url.hostname = CANONICAL_HOST;
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    return env.ASSETS.fetch(request);
  },
};
