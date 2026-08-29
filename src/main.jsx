import React from 'react';
import ReactDOM from 'react-dom/client';
import { useState } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import './styles.css';

const WORKER_BASE = '/api';

function parseURL(url) {
  const trimmed = url.trim();
  if (trimmed.includes('soundcloud.com')) {
    const isPlaylist = trimmed.includes('/sets/');
    return { isPlaylist };
  }
  return null;
}

function cleanText(value) {
  return String(value || '').trim();
}

function removeArtistPrefix(title, artist) {
  if (!title || !artist) return title;

  const escapedArtist = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`^${escapedArtist}\\s*[-–—:|]+\\s*`, 'i'), '').trim() || title;
}

function getTrackMeta(track, index = 0) {
  const publisher = track.publisher_metadata || {};
  const user = track.user || {};
  const artist = cleanText(
    publisher.artist ||
    publisher.writer_composer ||
    user.username ||
    user.full_name ||
    track.artist ||
    track.username
  );
  const rawTitle = cleanText(
    publisher.release_title ||
    publisher.title ||
    track.title ||
    track.name
  );
  const title = removeArtistPrefix(rawTitle, artist);

  return {
    artist: artist || 'Unknown Artist',
    title: title || `Track ${index + 1}`,
  };
}

function safeMp3Filename({ artist, title }) {
  return `${artist} - ${title}`.replace(/[\\/:*?"<>|]/g, '_') + '.mp3';
}

function getMp3Transcoding(track) {
  return track.media?.transcodings?.find(
    transcoding => transcoding.format?.protocol === 'progressive' &&
      transcoding.format?.mime_type === 'audio/mpeg'
  );
}

async function getTrackInfo(track, forceRefresh = false) {
  if (track.media?.transcodings && !forceRefresh) return track;

  const suffix = forceRefresh ? '?refresh=1' : '';
  const response = await fetch(`${WORKER_BASE}/tracks/${track.id}${suffix}`);
  if (!response.ok) {
    let message = `Track lookup failed (${response.status})`;
    try {
      const data = await response.json();
      message = data.error || message;
    } catch (_) {}
    throw new Error(message);
  }
  return response.json();
}

async function downloadTrack(track, index = 0, forceRefresh = false) {
  return downloadTrackWithProgress(track, index, forceRefresh);
}

async function readResponseBlob(response, onProgress) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    onProgress(1);
    return response.blob();
  }

  const reader = response.body.getReader();
  const chunks = [];
  const total = Number(response.headers.get('content-length')) || 0;
  let loaded = 0;

  if (!total) onProgress(null);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (total) onProgress(Math.min(loaded / total, 1));
  }

  onProgress(1);
  return new Blob(chunks, {
    type: response.headers.get('content-type') || 'audio/mpeg',
  });
}

function progressLabel(fraction) {
  return fraction === null ? 'LIVE' : `${Math.round(fraction * 100)}%`;
}

async function downloadTrackWithProgress(track, index = 0, forceRefresh = false, onProgress = () => {}) {
  const trackInfo = await getTrackInfo(track, forceRefresh);
  const { artist, title } = getTrackMeta(trackInfo, index);
  const mp3 = getMp3Transcoding(trackInfo);
  if (!mp3) throw new Error('No MP3 stream available');

  onProgress(0, { artist, title });

  const downloadParams = new URLSearchParams({
    url: mp3.url,
    artist,
    title,
  });
  if (forceRefresh) downloadParams.set('refresh', '1');

  const response = await fetch(`${WORKER_BASE}/download?${downloadParams}`);
  if (!response.ok) {
    let message = `Download failed (${response.status})`;
    try {
      const data = await response.json();
      message = data.error || message;
    } catch (_) {}
    throw new Error(message);
  }

  return {
    blob: await readResponseBlob(response, fraction => onProgress(fraction, { artist, title })),
    filename: safeMp3Filename({ artist, title }),
    artist,
    title,
  };
}

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [fallbackReady, setFallbackReady] = useState(false);
  const [progressIndeterminate, setProgressIndeterminate] = useState(false);

  const handleDownload = async ({ forceRefresh = false } = {}) => {
    if (!url.trim()) return;
    const parsed = parseURL(url);
    if (!parsed) {
      setError('Unsupported link. Use a SoundCloud track or playlist.');
      setFallbackReady(false);
      return;
    }
    const { isPlaylist } = parsed;

    setLoading(true);
    setError('');
    setFallbackReady(false);
    setProgressIndeterminate(false);
    setProgress(0);
    setStatus(forceRefresh ? 'TRYING BACKUP RESOLUTION...' : 'FETCHING...');

    try {
      const resolveParams = new URLSearchParams({ url: url.trim() });
      if (forceRefresh) resolveParams.set('refresh', '1');
      const resolveRes = await fetch(`${WORKER_BASE}/resolve?${resolveParams}`);
      if (!resolveRes.ok) {
        // Try to get error message from body
        let errMsg = `Resolve failed (${resolveRes.status})`;
        try {
          const errData = await resolveRes.json();
          errMsg = errData.error || errMsg;
        } catch (_) {}
        throw new Error(errMsg);
      }

      let data;
      try {
        data = await resolveRes.json();
      } catch (jsonErr) {
        throw new Error('Invalid response from server – please try again.');
      }

      if (!data.tracks || data.tracks.length === 0) throw new Error('No tracks found');

      const tracks = data.tracks;
      const total = tracks.length;
      setStatus(`FOUND ${total} TRACK(S). DOWNLOADING...`);

      // --- SINGLE TRACK (no ZIP) ---
      if (total === 1 && !isPlaylist) {
        const track = tracks[0];
        let result;
        try {
          result = await downloadTrackWithProgress(track, 0, forceRefresh, (fraction, meta) => {
            setProgressIndeterminate(fraction === null);
            setProgress(fraction * 100);
            if (meta) setStatus(`DOWNLOADING: ${meta.artist} - ${meta.title} ${progressLabel(fraction)}`);
          });
        } catch (firstError) {
          result = await downloadTrackWithProgress(track, 0, true, (fraction, meta) => {
            setProgressIndeterminate(fraction === null);
            setProgress(fraction * 100);
            if (meta) setStatus(`RETRYING: ${meta.artist} - ${meta.title} ${progressLabel(fraction)}`);
          }).catch(() => { throw firstError; });
        }
        setStatus(`DOWNLOADING: ${result.artist} - ${result.title}`);
        saveAs(result.blob, result.filename);
        setProgress(100);
        setStatus('DOWNLOAD COMPLETE');
        setLoading(false);
        return;
      }

      // --- MULTIPLE TRACKS → ZIP ---
      const zip = new JSZip();
      let addedTracks = 0;
      const skippedTracks = [];

      for (let i = 0; i < total; i++) {
        const track = tracks[i];
        setProgress(((i) / total) * 90);

        try {
          let result;
          try {
            result = await downloadTrackWithProgress(track, i, forceRefresh, (fraction, meta) => {
              setProgressIndeterminate(fraction === null);
              setProgress(((i + fraction) / total) * 90);
              if (meta) setStatus(`TRACK ${i + 1}/${total}: ${meta.artist} - ${meta.title} ${progressLabel(fraction)}`);
            });
          } catch (firstError) {
            result = await downloadTrackWithProgress(track, i, true, (fraction, meta) => {
              setProgressIndeterminate(fraction === null);
              setProgress(((i + fraction) / total) * 90);
              if (meta) setStatus(`RETRY ${i + 1}/${total}: ${meta.artist} - ${meta.title} ${progressLabel(fraction)}`);
            }).catch(() => { throw firstError; });
          }

          setStatus(`TRACK ${i + 1}/${total}: ${result.artist} - ${result.title}`);
          zip.file(result.filename, result.blob, { binary: true });
          addedTracks += 1;
        } catch {
          const { artist, title } = getTrackMeta(track, i);
          skippedTracks.push(`${artist} - ${title}`);
          setStatus(`SKIPPED ${skippedTracks.length}: ${artist} - ${title}`);
        }

        setProgress(((i + 1) / total) * 90);
      }

      if (addedTracks === 0) {
        throw new Error('No downloadable MP3 streams found in this playlist.');
      }

      setStatus('CREATING ZIP...');
      setProgressIndeterminate(false);
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      setProgress(100);
      saveAs(zipBlob, 'playlist.zip');
      setStatus(skippedTracks.length
        ? `DOWNLOAD COMPLETE - SKIPPED ${skippedTracks.length} UNAVAILABLE TRACK(S)`
        : 'DOWNLOAD COMPLETE');
    } catch (err) {
      setError(err.message);
      setFallbackReady(true);
      setProgressIndeterminate(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      <div className="card">
        <p className="eyebrow">SKATZ / AUDIO UTILITY</p>
        <h1 className="title">DOWNLOADER<br />FOR SKATZ</h1>
        <p className="subtitle">SOUNDCLOUD / MP3</p>

        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="PASTE SOUNDCLOUD TRACK OR PLAYLIST"
          className="url-input"
          disabled={loading}
        />

        <button
          onClick={handleDownload}
          disabled={loading || !url.trim()}
          className="download-btn"
        >
          {loading ? 'PROCESSING...' : 'DOWNLOAD'}
        </button>

        {status && <p className="status-text">{status}</p>}
        {error && (
        <div className="error-panel">
            <p className="error-text">{error}</p>
            {fallbackReady && (
              <button
                onClick={() => handleDownload({ forceRefresh: true })}
                disabled={loading}
                className="fallback-btn"
              >
                TRY BACKUP
              </button>
            )}
          </div>
        )}

        {loading && (
          <div className="progress-bg">
            <div className={`progress-fill${progressIndeterminate ? ' progress-indeterminate' : ''}`} style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
