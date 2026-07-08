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

  // ---------- CLIENT ID RESOLUTION ----------
  let cachedClientId = null;

  async function getSoundCloudClientId() {
    if (cachedClientId) return cachedClientId;

    // List of known public IDs (still active as of mid‑2026)
    const knownIds = [
      'a3e059563d7fd3372b49b37f00a00bcf',
      'iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX',
      '2t9loNQH90kzJcsFCODdigxfp325aq4z',
    ];

    for (const id of knownIds) {
      try {
        const test = await fetch(`https://api-v2.soundcloud.com/tracks/1?client_id=${id}`);
        if (test.ok) {
          cachedClientId = id;
          return id;
        }
      } catch (_) { /* skip */ }
    }

    // Fallback: scrape SoundCloud homepage
    try {
      const homeRes = await fetch('https://soundcloud.com', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const text = await homeRes.text();
      // Look for the standard client_id pattern in script tags
      const match = text.match(/(?:client_id=|client_id:)\s*["']?([a-zA-Z0-9]{32})["']?/);
      if (match && match[1]) {
        cachedClientId = match[1];
        return match[1];
      }
    } catch (_) { /* fall through */ }

    throw new Error('No valid SoundCloud client ID found. Please try again later.');
  }

  // ---------- URL HELPERS ----------
  async function expandSoundCloudShortUrl(shortUrl) {
    // Follow redirects to get the full URL
    const resp = await fetch(shortUrl, { redirect: 'follow', method: 'HEAD' });
    return resp.url; // final URL after redirects
  }

  function extractYouTubeID(input) {
    const patterns = [
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
      /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) {
      const m = input.match(p);
      if (m) return m[1];
    }
    return null;
  }

  async function getYouTubePlaylistTracks(playlistUrl) {
    const res = await fetch(playlistUrl);
    const html = await res.text();
    const videoIds = [];
    const regex = /\/watch\?v=([a-zA-Z0-9_-]{11})/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      if (!videoIds.includes(match[1])) videoIds.push(match[1]);
    }
    return videoIds.map(id => ({ id, title: 'YouTube Track', artist: 'YouTube' }));
  }

  async function getYouTubeMP3(videoId) {
    const apiUrl = `https://loader.to/api/card/?url=https://www.youtube.com/watch?v=${videoId}&format=mp3`;
    const resp = await fetch(apiUrl);
    const data = await resp.json();
    if (data.success && data.link) {
      return { downloadUrl: data.link, title: data.title || 'Unknown' };
    }
    throw new Error('Could not convert YouTube video');
  }

  // ---------- ROUTES ----------
  try {
    // 1. RESOLVE
    if (pathname === '/api/resolve') {
      const scUrl = params.get('url');
      if (!scUrl) throw new Error('Missing url parameter');
      let trimmed = scUrl.trim();

      // Expand shortened SoundCloud links
      if (trimmed.includes('on.soundcloud.com')) {
        try {
          trimmed = await expandSoundCloudShortUrl(trimmed);
        } catch {
          throw new Error('Could not expand short SoundCloud link. Try using the full URL.');
        }
      }

      // SoundCloud
      if (trimmed.includes('soundcloud.com')) {
        const clientId = await getSoundCloudClientId();
        const apiUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(trimmed)}&client_id=${clientId}`;
        const resp = await fetch(apiUrl);
        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          throw new Error(`SoundCloud API error ${resp.status}: ${text.slice(0, 200)}`);
        }
        let data;
        try {
          data = await resp.json();
        } catch {
          throw new Error('SoundCloud returned invalid JSON (client ID may be invalid)');
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

      // YouTube
      if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
        const videoId = extractYouTubeID(trimmed);
        if (trimmed.includes('list=')) {
          const tracks = await getYouTubePlaylistTracks(trimmed);
          return new Response(JSON.stringify({ tracks }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } else if (videoId) {
          return new Response(JSON.stringify({ tracks: [{ id: videoId }] }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        throw new Error('Could not parse YouTube URL');
      }

      throw new Error('Unsupported URL');
    }

    // 2. TRACK INFO (SoundCloud)
    if (pathname.startsWith('/api/tracks/')) {
      const trackId = pathname.split('/')[3];
      const clientId = await getSoundCloudClientId();
      const apiUrl = `https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${clientId}`;
      const resp = await fetch(apiUrl);
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. DOWNLOAD
    if (pathname === '/api/download') {
      const platform = params.get('platform');
      const trackId = params.get('trackId');
      const streamUrl = params.get('url');
      const artist = params.get('artist') || 'Unknown';
      const title = params.get('title') || 'track';

      if (platform === 'soundcloud' && streamUrl) {
        const audioResp = await fetch(streamUrl);
        if (!audioResp.ok) throw new Error('SoundCloud stream fetch failed');
        const headers = new Headers(audioResp.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Content-Disposition', `attachment; filename="${artist} - ${title}.mp3"`);
        return new Response(audioResp.body, { headers });
      }

      if (platform === 'youtube' && trackId) {
        const { downloadUrl, title: ytTitle } = await getYouTubeMP3(trackId);
        const finalTitle = ytTitle || title;
        const safeFilename = `${artist} - ${finalTitle}`.replace(/[\\/:*?"<>|]/g, '_') + '.mp3';
        const audioResp = await fetch(downloadUrl);
        if (!audioResp.ok) throw new Error('YouTube MP3 fetch failed');
        const headers = new Headers();
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Content-Disposition', `attachment; filename="${safeFilename}"`);
        if (audioResp.headers.get('content-type'))
          headers.set('Content-Type', audioResp.headers.get('content-type'));
        return new Response(audioResp.body, { headers });
      }

      throw new Error('Missing parameters for download');
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}