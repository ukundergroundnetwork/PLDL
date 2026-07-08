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

  // ---------- HELPERS ----------

  async function getSoundCloudClientId() {
    const res = await fetch('https://soundcloud.com');
    const text = await res.text();
    const match = text.match(/client_id:\s*"([a-zA-Z0-9]+)"/);
    if (match) return match[1];
    const alt = text.match(/client_id=([a-zA-Z0-9]+)/);
    if (alt) return alt[1];
    throw new Error('Could not extract SoundCloud client_id');
  }

  // Extract YouTube video ID from various URL formats
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

  // YouTube: fetch playlist items (via a public API proxy or oEmbed – we'll use a simple scraping method)
  async function getYouTubePlaylistTracks(playlistUrl) {
    // For simplicity, we'll use the YouTube Data API via a public "no-key" endpoint (loader.to) to get the playlist info.
    // However, to avoid keys, we'll use a trick: fetch the playlist page and extract video IDs with a regex.
    const res = await fetch(playlistUrl);
    const html = await res.text();
    // Extract video IDs from the playlist page (pattern: "/watch?v=XXXX")
    const videoIds = [];
    const regex = /\/watch\?v=([a-zA-Z0-9_-]{11})/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      if (!videoIds.includes(match[1])) videoIds.push(match[1]);
    }
    // Fallback: if we didn't find enough, try a public API (no key) – but this might break. We'll provide a manual alternative later.
    // For now, we'll use the scraped IDs.
    const tracks = videoIds.map(id => ({
      id,
      title: 'YouTube Track', // will be filled from converter
      artist: 'YouTube',
    }));
    return tracks;
  }

  // Convert YouTube video ID to MP3 using a public API (loader.to)
  async function getYouTubeMP3(videoId) {
    const apiUrl = `https://loader.to/api/card/?url=https://www.youtube.com/watch?v=${videoId}&format=mp3`;
    const resp = await fetch(apiUrl);
    const data = await resp.json();
    if (data.success && data.link) {
      return { downloadUrl: data.link, title: data.title || 'Unknown' };
    }
    throw new Error('Could not convert YouTube video');
  }

  // ---------- ROUTING ----------

  try {
    // 1. RESOLVE (playlist/single)
    if (pathname === '/api/resolve') {
      const scUrl = params.get('url');
      const trimmed = scUrl.trim();

      // -- SoundCloud --
      if (trimmed.includes('soundcloud.com')) {
        const clientId = await getSoundCloudClientId();
        const apiUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(trimmed)}&client_id=${clientId}`;
        const resp = await fetch(apiUrl);
        const data = await resp.json();
        // If it's a single track, wrap it in a tracks array
        if (data.kind === 'track') {
          return new Response(JSON.stringify({ tracks: [data] }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        // playlist
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // -- YouTube --
      if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
        const videoId = extractYouTubeID(trimmed);
        // Check if it's a playlist (URL contains 'list=')
        if (trimmed.includes('list=')) {
          // It's a playlist – scrape video IDs
          const tracks = await getYouTubePlaylistTracks(trimmed);
          return new Response(JSON.stringify({ tracks }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } else if (videoId) {
          // Single video
          return new Response(JSON.stringify({ tracks: [{ id: videoId }] }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        throw new Error('Could not parse YouTube URL');
      }

      throw new Error('Unsupported URL');
    }

    // 2. GET TRACK INFO (used for SoundCloud only, for stream URL)
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

    // 3. DOWNLOAD (SoundCloud direct or YouTube via converter)
    if (pathname === '/api/download') {
      const platform = params.get('platform');
      const trackId = params.get('trackId');
      const streamUrl = params.get('url'); // for SoundCloud progressive URL
      const artist = params.get('artist') || 'Unknown';
      const title = params.get('title') || 'track';

      if (platform === 'soundcloud' && streamUrl) {
        const audioResp = await fetch(streamUrl);
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
        const headers = new Headers();
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Content-Disposition', `attachment; filename="${safeFilename}"`);
        // Forward content-type from the remote server
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