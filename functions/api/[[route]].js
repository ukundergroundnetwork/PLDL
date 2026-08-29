let cachedClientId = '';
let cachedClientIdExpiresAt = 0;

const FALLBACK_CLIENT_ID = 'Pb72ranhoyt6gw7hM7TkzUItXlMWSNSo';
const CLIENT_ID_CACHE_MS = 15 * 60 * 1000;

export async function onRequest(context) {
  const { request, env = {} } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const params = url.searchParams;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const configuredClientId = String(env.SOUNDCLOUD_CLIENT_ID || '').trim();

  function uniqueClientIds(values) {
    return [...new Set(values.filter(value => /^[A-Za-z0-9_-]{20,}$/.test(value)))];
  }

  async function discoverClientId() {
    const homepage = await fetch('https://soundcloud.com/', {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; PLDL/1.0)',
      },
    });

    if (!homepage.ok) {
      throw new Error(`SoundCloud homepage unavailable (${homepage.status})`);
    }

    const html = await homepage.text();
    const scriptUrls = [...new Set(
      [...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"'\s>]+\.js/g)]
        .map(match => match[0])
    )];

    // The homepage normally exposes the current bundle URLs. Fetch only a
    // bounded number so a client-ID refresh remains cheap inside a Worker.
    const bundles = await Promise.all(
      scriptUrls.slice(0, 20).map(async scriptUrl => {
        try {
          const response = await fetch(scriptUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PLDL/1.0)' },
          });
          return response.ok ? response.text() : '';
        } catch {
          return '';
        }
      })
    );

    const discovered = [];
    for (const bundle of bundles) {
      const directMatches = [
        ...bundle.matchAll(/(?:client_id|clientId)\s*[:=]\s*["']([A-Za-z0-9_-]{20,})["']/g),
        ...bundle.matchAll(/client_id=([A-Za-z0-9_-]{20,})/g),
      ];
      discovered.push(...directMatches.map(match => match[1]));
    }

    const clientId = uniqueClientIds(discovered)[0];
    if (!clientId) throw new Error('Could not discover a current SoundCloud client ID');

    cachedClientId = clientId;
    cachedClientIdExpiresAt = Date.now() + CLIENT_ID_CACHE_MS;
    return clientId;
  }

  async function getClientIds(forceRefresh = false) {
    const ids = [];

    if (!forceRefresh && cachedClientId && cachedClientIdExpiresAt > Date.now()) {
      ids.push(cachedClientId);
    }

    if (forceRefresh) {
      cachedClientId = '';
      cachedClientIdExpiresAt = 0;
      try {
        ids.push(await discoverClientId());
      } catch {
        // Continue with configured and last-known public fallbacks.
      }
    }

    ids.push(configuredClientId, FALLBACK_CLIENT_ID);
    return uniqueClientIds(ids);
  }

  async function fetchWithClientId(urlBuilder, { forceRefresh = false } = {}) {
    const attempted = new Set();
    let lastResponse = null;

    const tryIds = async ids => {
      for (const clientId of ids) {
        if (attempted.has(clientId)) continue;
        attempted.add(clientId);

        const response = await fetch(urlBuilder(clientId), {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PLDL/1.0)' },
        });
        lastResponse = response;

        if (response.ok) {
          cachedClientId = clientId;
          cachedClientIdExpiresAt = Date.now() + CLIENT_ID_CACHE_MS;
          return response;
        }

        // A non-auth error is useful to the caller and should not be hidden by
        // trying unrelated IDs. Auth failures do trigger the discovery path.
        if (![401, 403].includes(response.status)) return response;
      }
      return null;
    };

    const firstResponse = await tryIds(await getClientIds(forceRefresh));
    if (firstResponse) return firstResponse;

    try {
      const discovered = await discoverClientId();
      const refreshedResponse = await tryIds([discovered]);
      if (refreshedResponse) return refreshedResponse;
    } catch {
      // Return the last API response below so the caller gets a useful status.
    }

    return lastResponse;
  }

  async function soundCloudJson(urlBuilder, options = {}) {
    const response = await fetchWithClientId(urlBuilder, options);
    if (!response) throw new Error('SoundCloud did not return a response');

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`SoundCloud API error ${response.status}: ${body.slice(0, 200)}`);
    }

    try {
      return await response.json();
    } catch {
      throw new Error('SoundCloud returned invalid JSON');
    }
  }

  function withClientId(rawUrl, clientId) {
    const target = new URL(rawUrl);
    target.searchParams.set('client_id', clientId);
    return target.toString();
  }

  async function expandShortUrl(shortUrl) {
    for (const method of ['HEAD', 'GET']) {
      try {
        const response = await fetch(shortUrl, {
          method,
          redirect: 'follow',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PLDL/1.0)' },
        });
        if (response.url && !response.url.includes('on.soundcloud.com')) {
          return response.url;
        }
      } catch {
        // Try the next redirect method.
      }
    }

    throw new Error('Could not expand short SoundCloud link. Try using the full URL.');
  }

  async function getSoundCloudStream(streamUrl, forceRefresh = false) {
    let lastError = 'SoundCloud stream unavailable';

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const transcodeResp = await fetchWithClientId(
        clientId => withClientId(streamUrl, clientId),
        { forceRefresh: forceRefresh || attempt > 0 }
      );

      if (!transcodeResp) {
        lastError = 'SoundCloud stream URL resolve failed';
        continue;
      }

      if (!transcodeResp.ok) {
        lastError = `SoundCloud stream URL resolve failed (${transcodeResp.status})`;
        if (![401, 403, 404].includes(transcodeResp.status)) break;
        continue;
      }

      let streamData;
      try {
        streamData = await transcodeResp.json();
      } catch {
        lastError = 'SoundCloud stream URL returned invalid JSON';
        continue;
      }

      if (!streamData.url) {
        lastError = 'SoundCloud stream URL missing';
        continue;
      }

      const audioResp = await fetch(streamData.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PLDL/1.0)' },
      });
      if (audioResp.ok) return audioResp;

      lastError = `SoundCloud stream fetch failed (${audioResp.status})`;
      if (![401, 403, 404].includes(audioResp.status)) break;
    }

    throw new Error(lastError);
  }

  try {
    if (pathname === '/api/ping') {
      return new Response(JSON.stringify({
        alive: true,
        clientIdSource: cachedClientId ? 'discovered' : 'fallback',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (pathname === '/api/resolve') {
      const scUrl = params.get('url');
      if (!scUrl) throw new Error('Missing url parameter');

      let trimmed = scUrl.trim();
      if (trimmed.includes('on.soundcloud.com')) trimmed = await expandShortUrl(trimmed);
      if (!trimmed.includes('soundcloud.com')) {
        throw new Error('Unsupported URL. Use a SoundCloud track or playlist.');
      }

      const data = await soundCloudJson(
        clientId => `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(trimmed)}&client_id=${clientId}`,
        { forceRefresh: params.get('refresh') === '1' }
      );

      if (data.errors) throw new Error(data.errors?.[0]?.error_message || 'Resolve failed');
      if (data.kind === 'track') {
        return new Response(JSON.stringify({ tracks: [data] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (pathname.startsWith('/api/tracks/')) {
      const trackId = pathname.split('/')[3];
      if (!trackId) throw new Error('Missing track ID');

      const data = await soundCloudJson(
        clientId => `https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${clientId}`,
        { forceRefresh: params.get('refresh') === '1' }
      );

      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (pathname === '/api/download') {
      const streamUrl = params.get('url');
      const artist = params.get('artist') || 'Unknown';
      const title = params.get('title') || 'track';
      if (!streamUrl) throw new Error('Missing stream URL');

      const audioResp = await getSoundCloudStream(streamUrl, params.get('refresh') === '1');
      const headers = new Headers(audioResp.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Content-Disposition', `attachment; filename="${artist} - ${title}.mp3"`);
      return new Response(audioResp.body, { headers });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || 'Request failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
