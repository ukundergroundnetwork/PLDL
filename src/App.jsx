import { useState } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

const WORKER_BASE = '/api';

export default function App() {
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
    setStatus('Fetching playlist...');

    try {
      const resolveRes = await fetch(`${WORKER_BASE}/resolve?url=${encodeURIComponent(url.trim())}`);
      if (!resolveRes.ok) throw new Error('Playlist not found');
      const playlistData = await resolveRes.json();

      if (!playlistData.tracks || playlistData.tracks.length === 0) {
        throw new Error('No tracks found');
      }

      const tracks = playlistData.tracks;
      const total = tracks.length;
      setStatus(`Found ${total} tracks. Downloading...`);

      const zip = new JSZip();

      for (let i = 0; i < total; i++) {
        const track = tracks[i];
        const title = track.title || `track-${i+1}`;
        const artist = track.user?.username || 'Unknown';
        const safeFilename = `${artist} - ${title}`.replace(/[\\/:*?"<>|]/g, '_') + '.mp3';

        setStatus(`Track ${i+1}/${total}: ${title}`);
        setProgress(((i) / total) * 90);

        let trackInfo = track;
        if (!track.media?.transcodings) {
          const trackRes = await fetch(`${WORKER_BASE}/tracks/${track.id}`);
          trackInfo = await trackRes.json();
        }

        const mp3Transcoding = trackInfo.media?.transcodings?.find(
          t => t.format?.protocol === 'progressive' && t.format?.mime_type === 'audio/mpeg'
        );

        if (!mp3Transcoding) throw new Error(`No MP3 stream for "${title}"`);

        const streamUrl = mp3Transcoding.url;
        const downloadUrl = `${WORKER_BASE}/download?url=${encodeURIComponent(streamUrl)}`;

        const audioBlob = await fetch(downloadUrl).then(res => {
          if (!res.ok) throw new Error('Download failed');
          return res.blob();
        });

        zip.file(safeFilename, audioBlob, { binary: true });
        setProgress(((i + 1) / total) * 90);
      }

      setStatus('Creating ZIP...');
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      setProgress(100);
      saveAs(zipBlob, `${playlistData.title || 'playlist'}.zip`);
      setStatus('Download complete!');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>🎵 SC Playlist DL</h1>
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="Paste SoundCloud playlist URL"
          style={styles.input}
          disabled={loading}
        />
        <button
          onClick={handleDownload}
          disabled={loading || !url.trim()}
          style={{ ...styles.button, opacity: loading ? 0.7 : 1 }}
        >
          {loading ? 'Downloading...' : 'Download All as ZIP'}
        </button>
        {status && <p style={styles.status}>{status}</p>}
        {error && <p style={styles.error}>❌ {error}</p>}
        {loading && (
          <div style={styles.progressBarBg}>
            <div style={{ ...styles.progressBarFill, width: `${progress}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100%', padding: '20px', boxSizing: 'border-box'
  },
  card: {
    width: '100%', maxWidth: '400px', background: 'rgba(255,255,255,0.1)',
    backdropFilter: 'blur(10px)', borderRadius: '16px', padding: '24px',
    textAlign: 'center', boxShadow: '0 8px 32px rgba(0,0,0,0.3)'
  },
  title: { fontSize: '1.5rem', marginBottom: '20px', marginTop: 0, color: '#ff5500' },
  input: {
    width: '100%', padding: '12px', borderRadius: '8px', border: 'none',
    fontSize: '1rem', background: 'rgba(255,255,255,0.15)', color: '#fff',
    outline: 'none', marginBottom: '16px', boxSizing: 'border-box'
  },
  button: {
    width: '100%', padding: '14px', borderRadius: '8px', border: 'none',
    background: '#ff5500', color: '#fff', fontWeight: 'bold', fontSize: '1rem',
    cursor: 'pointer', transition: 'background 0.2s', marginBottom: '16px'
  },
  status: { color: '#ccc', fontSize: '0.9rem', margin: '8px 0' },
  error: { color: '#ff4444', fontSize: '0.9rem', margin: '8px 0' },
  progressBarBg: {
    width: '100%', height: '6px', background: 'rgba(255,255,255,0.2)',
    borderRadius: '3px', overflow: 'hidden', marginTop: '8px'
  },
  progressBarFill: {
    height: '100%', background: '#ff5500', borderRadius: '3px', transition: 'width 0.3s ease'
  }
};
