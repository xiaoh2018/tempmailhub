export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = buildCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    if (!isAllowedPath(url.pathname)) {
      return json(
        {
          error: 'unsupported_path',
          message: 'Only /v2/inbox/create and /v2/inbox are supported.'
        },
        404,
        corsHeaders
      );
    }

    if (env.PROXY_SHARED_TOKEN) {
      const proxyToken = request.headers.get('x-proxy-token');
      if (!proxyToken || proxyToken !== env.PROXY_SHARED_TOKEN) {
        return json(
          {
            error: 'unauthorized_proxy_client',
            message: 'Invalid or missing x-proxy-token header.'
          },
          401,
          corsHeaders
        );
      }
    }

    if (url.pathname === '/v2/inbox/create' && request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, corsHeaders);
    }

    if (url.pathname === '/v2/inbox' && request.method !== 'GET') {
      return json({ error: 'method_not_allowed' }, 405, corsHeaders);
    }

    const upstreamUrl = new URL(`https://api.tempmail.lol${url.pathname}${url.search}`);
    const headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('User-Agent', 'tempmailhub-tempmaillol-proxy/1.0');

    if (request.method === 'POST') {
      headers.set('Content-Type', 'application/json');
    }

    if (env.TEMPMAILLOL_API_KEY) {
      headers.set('Authorization', `Bearer ${env.TEMPMAILLOL_API_KEY}`);
    }

    let upstreamResponse;

    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), {
        method: request.method,
        headers,
        body: request.method === 'POST' ? await request.text() : undefined
      });
    } catch (error) {
      return json(
        {
          error: 'upstream_fetch_failed',
          message: error instanceof Error ? error.message : 'Unknown upstream error'
        },
        502,
        corsHeaders
      );
    }

    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set('Content-Type', upstreamResponse.headers.get('Content-Type') || 'application/json');
    responseHeaders.set('Cache-Control', 'no-store');

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders
    });
  }
};

function isAllowedPath(pathname) {
  return pathname === '/v2/inbox/create' || pathname === '/v2/inbox';
}

function buildCorsHeaders(request, env) {
  const requestOrigin = request.headers.get('Origin') || '*';
  const allowedOrigin = env.ALLOWED_ORIGIN || requestOrigin;

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function json(payload, status, corsHeaders) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders
    }
  });
}
