export async function onRequest(context) {
  const { request } = context;
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

  const SOUNDCLOUD_CLIENT_ID = '6bs1QjDBWrmh7FpcKrIDvzodJ2ZZpRwe';

  async function expandShortUrl(shortUrl) {
    const resp = await fetch(shortUrl, { redirect: 'follow', method: 'HEAD' });
    return resp.url;
  }

  async function getSoundCloudStream(streamUrl) {
    const separator = streamUrl.includes('?') ? '&' : '?';
    const transcodeResp = await fetch(`${streamUrl}${separator}client_id=${SOUNDCLOUD_CLIENT_ID}`);
    if (!transcodeResp.ok) throw new Error('SoundCloud stream URL resolve failed');

    const streamData = await transcodeResp.json();
    if (!streamData.url) throw new Error('SoundCloud stream URL missing');

    const audioResp = await fetch(streamData.url);
    if (!audioResp.ok) throw new Error('SoundCloud stream fetch failed');

    return audioResp;
  }

  try {
    if (pathname === '/api/ping') {
      return new Response(JSON.stringify({ alive: true, clientId: SOUNDCLOUD_CLIENT_ID }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (pathname === '/api/resolve') {
      const scUrl = params.get('url');
      if (!scUrl) throw new Error('Missing url parameter');

      let trimmed = scUrl.trim();
      if (trimmed.includes('on.soundcloud.com')) {
        try {
          trimmed = await expandShortUrl(trimmed);
        } catch {
          throw new Error('Could not expand short SoundCloud link. Try using the full URL.');
        }
      }

      if (!trimmed.includes('soundcloud.com')) {
        throw new Error('Unsupported URL. Use a SoundCloud track or playlist.');
      }

      const apiUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(trimmed)}&client_id=${SOUNDCLOUD_CLIENT_ID}`;
      const resp = await fetch(apiUrl);
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`SoundCloud API error ${resp.status}: ${text.slice(0, 200)}`);
      }

      let data;
      try {
        data = await resp.json();
      } catch {
        throw new Error('SoundCloud returned invalid JSON.');
      }

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
      const apiUrl = `https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${SOUNDCLOUD_CLIENT_ID}`;
      const resp = await fetch(apiUrl);
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (pathname === '/api/download') {
      const streamUrl = params.get('url');
      const artist = params.get('artist') || 'Unknown';
      const title = params.get('title') || 'track';
      if (!streamUrl) throw new Error('Missing stream URL');

      const audioResp = await getSoundCloudStream(streamUrl);
      const headers = new Headers(audioResp.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Content-Disposition', `attachment; filename="${artist} - ${title}.mp3"`);
      return new Response(audioResp.body, { headers });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
