import React from 'react';
import ReactDOM from 'react-dom/client';
import { useState } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import './styles.css';

const WORKER_BASE = '/api';

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const handleDownload = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError('');
    setProgress(0);
    setStatus('FETCHING PLAYLIST...');

    try {
      const resolveRes = await fetch(
        `${WORKER_BASE}/resolve?url=${encodeURIComponent(url.trim())}`
      );
      if (!resolveRes.ok) throw new Error('Playlist not found');
      const playlistData = await resolveRes.json();

      if (!playlistData.tracks || playlistData.tracks.length === 0)
        throw new Error('No tracks found');

      const tracks = playlistData.tracks;
      const total = tracks.length;
      setStatus(`FOUND ${total} TRACKS. DOWNLOADING...`);

      const zip = new JSZip();

      for (let i = 0; i < total; i++) {
        const track = tracks[i];
        const artist = track.user?.username || 'Unknown';
        const title = track.title || `track-${i + 1}`;
        const safeFilename = `${artist} - ${title}`.replace(/[\\/:*?"<>|]/g, '_') + '.mp3';

        setStatus(`TRACK ${i + 1}/${total}: ${title}`);
        setProgress(((i) / total) * 90);

        let trackInfo = track;
        if (!track.media?.transcodings) {
          const trackRes = await fetch(`${WORKER_BASE}/tracks/${track.id}`);
          trackInfo = await trackRes.json();
        }

        const mp3 = trackInfo.media?.transcodings?.find(
          t => t.format?.protocol === 'progressive' && t.format?.mime_type === 'audio/mpeg'
        );
        if (!mp3) throw new Error(`No MP3 stream for "${title}"`);

        const streamUrl = mp3.url;
        const downloadUrl = `${WORKER_BASE}/download?url=${encodeURIComponent(streamUrl)}`;

        const audioBlob = await fetch(downloadUrl).then(res => {
          if (!res.ok) throw new Error('Download failed');
          return res.blob();
        });

        zip.file(safeFilename, audioBlob, { binary: true });
        setProgress(((i + 1) / total) * 90);
      }

      setStatus('CREATING ZIP...');
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      setProgress(100);
      saveAs(zipBlob, `${playlistData.title || 'playlist'}.zip`);
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
        <h1 className="title">🎵 PLAYLIST DL</h1>
        <p className="subtitle">SOUNDCLOUD · SPOTIFY · YOUTUBE</p>

        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="PASTE PLAYLIST LINK"
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