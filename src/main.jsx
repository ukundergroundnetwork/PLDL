import React from 'react';
import ReactDOM from 'react-dom/client';
import { useState } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import './styles.css';

const WORKER_BASE = '/api';

// Detect platform and if it's a single track or playlist
function parseURL(url) {
  const trimmed = url.trim();
  if (trimmed.includes('soundcloud.com')) {
    // SoundCloud: single track vs playlist/set
    const isPlaylist = trimmed.includes('/sets/');
    return { platform: 'soundcloud', isPlaylist };
  }
  if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
    // YouTube: playlist if URL contains 'list='
    const isPlaylist = trimmed.includes('list=');
    // If it's a short link youtu.be/VIDEO_ID, it's always single
    return { platform: 'youtube', isPlaylist };
  }
  return null;
}

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const handleDownload = async () => {
    if (!url.trim()) return;
    const parsed = parseURL(url);
    if (!parsed) {
      setError('Unsupported link. Use SoundCloud or YouTube playlist/video.');
      return;
    }
    const { platform, isPlaylist } = parsed;

    setLoading(true);
    setError('');
    setProgress(0);
    setStatus('FETCHING...');

    try {
      const resolveRes = await fetch(
        `${WORKER_BASE}/resolve?url=${encodeURIComponent(url.trim())}`
      );
      if (!resolveRes.ok) throw new Error('Could not resolve link');
      const data = await resolveRes.json();
      const tracks = data.tracks;
      if (!tracks || tracks.length === 0) throw new Error('No tracks found');

      const total = tracks.length;
      setStatus(`FOUND ${total} TRACK(S). DOWNLOADING...`);

      // If only one track and it's not a playlist, download directly (no ZIP)
      if (total === 1 && !isPlaylist) {
        const track = tracks[0];
        const artist = track.user?.username || track.artist || 'Unknown';
        const title = track.title || 'track';
        setStatus(`DOWNLOADING: ${title}`);

        let downloadUrl;
        if (platform === 'soundcloud') {
          // Get stream URL
          let trackInfo = track;
          if (!track.media?.transcodings) {
            const trackRes = await fetch(`${WORKER_BASE}/tracks/${track.id}`);
            trackInfo = await trackRes.json();
          }
          const mp3 = trackInfo.media?.transcodings?.find(
            t => t.format?.protocol === 'progressive' && t.format?.mime_type === 'audio/mpeg'
          );
          if (!mp3) throw new Error('No MP3 stream available');
          downloadUrl = `${WORKER_BASE}/download?platform=soundcloud&url=${encodeURIComponent(mp3.url)}&artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
        } else if (platform === 'youtube') {
          downloadUrl = `${WORKER_BASE}/download?platform=youtube&trackId=${encodeURIComponent(track.id)}&artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
        }

        const resp = await fetch(downloadUrl);
        if (!resp.ok) throw new Error('Download failed');
        const blob = await resp.blob();
        saveAs(blob, `${artist} - ${title}.mp3`);
        setProgress(100);
        setStatus('DOWNLOAD COMPLETE');
        setLoading(false);
        return;
      }

      // Multiple tracks (or playlist) → ZIP
      const zip = new JSZip();
      for (let i = 0; i < total; i++) {
        const track = tracks[i];
        const artist = track.user?.username || track.artist || 'Unknown';
        const title = track.title || `track-${i + 1}`;
        const safeFilename = `${artist} - ${title}`.replace(/[\\/:*?"<>|]/g, '_') + '.mp3';

        setStatus(`TRACK ${i + 1}/${total}: ${title}`);
        setProgress(((i) / total) * 90);

        let audioBlob;
        if (platform === 'soundcloud') {
          let trackInfo = track;
          if (!track.media?.transcodings) {
            const trackRes = await fetch(`${WORKER_BASE}/tracks/${track.id}`);
            trackInfo = await trackRes.json();
          }
          const mp3 = trackInfo.media?.transcodings?.find(
            t => t.format?.protocol === 'progressive' && t.format?.mime_type === 'audio/mpeg'
          );
          if (!mp3) throw new Error(`No MP3 for "${title}"`);
          const downloadUrl = `${WORKER_BASE}/download?platform=soundcloud&url=${encodeURIComponent(mp3.url)}&artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
          const resp = await fetch(downloadUrl);
          if (!resp.ok) throw new Error('Download failed');
          audioBlob = await resp.blob();
        } else if (platform === 'youtube') {
          const downloadUrl = `${WORKER_BASE}/download?platform=youtube&trackId=${encodeURIComponent(track.id)}&artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
          const resp = await fetch(downloadUrl);
          if (!resp.ok) throw new Error('Download failed');
          audioBlob = await resp.blob();
        }
        zip.file(safeFilename, audioBlob, { binary: true });
        setProgress(((i + 1) / total) * 90);
      }

      setStatus('CREATING ZIP...');
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      setProgress(100);
      saveAs(zipBlob, `playlist.zip`);
      setStatus('DOWNLOAD COMPLETE');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-container">
      <div className="card">
        <h1 className="title">🎵 PLAYLIST DL 🎵</h1>
        <p className="subtitle">SOUNDCLOUD OR YOUTUBE</p>

        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="PASTE PLAYLIST OR TRACK LINK"
          className="url-input"
          disabled={loading}
        />

        <button
          onClick={handleDownload}
          disabled={loading || !url.trim()}
          className="download-btn"
        >
          {loading ? 'DOWNLOADING...' : 'DOWNLOAD AS ZIP'}
        </button>

        {status && <p className="status-text">{status}</p>}
        {error && <p className="error-text">❌ {error}</p>}

        {loading && (
          <div className="progress-bg">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
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