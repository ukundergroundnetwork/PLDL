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
    return { platform: 'soundcloud', isPlaylist };
  }
  if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
    const isPlaylist = trimmed.includes('list=');
    return { platform: 'youtube', isPlaylist };
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

function normalizeConverterProgress(value) {
  const progress = Number(value) || 0;
  return Math.max(0, Math.min(100, progress > 100 ? progress / 10 : progress));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

        let downloadUrl;
        let trackInfo = track;
        if (platform === 'soundcloud') {
          if (!track.media?.transcodings) {
            const trackRes = await fetch(`${WORKER_BASE}/tracks/${track.id}`);
            trackInfo = await trackRes.json();
          }
          const { artist, title } = getTrackMeta(trackInfo);
          setStatus(`DOWNLOADING: ${artist} - ${title}`);
          const mp3 = trackInfo.media?.transcodings?.find(
            t => t.format?.protocol === 'progressive' && t.format?.mime_type === 'audio/mpeg'
          );
          if (!mp3) throw new Error('No MP3 stream available');
          downloadUrl = `${WORKER_BASE}/download?platform=soundcloud&url=${encodeURIComponent(mp3.url)}&artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
        } else if (platform === 'youtube') {
          const { artist, title } = getTrackMeta(trackInfo);
          setStatus(`DOWNLOADING: ${artist} - ${title}`);
          downloadUrl = `${WORKER_BASE}/download?platform=youtube&trackId=${encodeURIComponent(track.id)}&artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
        }

        const resp = await fetch(downloadUrl);
        if (!resp.ok) throw new Error('Download failed');
        const blob = await resp.blob();
        saveAs(blob, safeMp3Filename(getTrackMeta(trackInfo)));
        setProgress(100);
        setStatus('DOWNLOAD COMPLETE');
        setLoading(false);
        return;
      }

      // --- MULTIPLE TRACKS → ZIP ---
      const zip = new JSZip();
      if (platform === 'youtube') {
        for (let i = 0; i < total; i++) {
          const track = tracks[i];
          let { artist, title } = getTrackMeta(track, i);

          setStatus(`TRACK ${i + 1}/${total}: STARTING ${artist} - ${title}`);
          const startRes = await fetch(`${WORKER_BASE}/youtube/start?trackId=${encodeURIComponent(track.id)}`);
          if (!startRes.ok) throw new Error(`Could not start "${title}"`);

          const startData = await startRes.json();
          let downloadUrl = '';

          for (let attempt = 0; attempt < 45; attempt++) {
            await wait(2000);

            const progressRes = await fetch(
              `${WORKER_BASE}/youtube/progress?progressUrl=${encodeURIComponent(startData.progressUrl)}&artist=${encodeURIComponent(artist)}`
            );
            if (!progressRes.ok) throw new Error(`Could not check "${title}"`);

            const progressData = await progressRes.json();
            const trackProgress = normalizeConverterProgress(progressData.progress);
            const totalProgress = ((i + trackProgress / 100) / total) * 90;
            setProgress(totalProgress);
            setStatus(`TRACK ${i + 1}/${total}: ${trackProgress}% ${artist} - ${title}`);

            if (progressData.title) title = progressData.title;
            if (progressData.download_url) {
              downloadUrl = progressData.download_url;
              break;
            }
          }

          if (!downloadUrl) throw new Error(`Timed out converting "${title}"`);

          setStatus(`TRACK ${i + 1}/${total}: DOWNLOADING ${artist} - ${title}`);
          const resp = await fetch(
            `${WORKER_BASE}/download?platform=youtube&downloadUrl=${encodeURIComponent(downloadUrl)}&artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`
          );
          if (!resp.ok) throw new Error(`Download failed for "${title}"`);

          const audioBlob = await resp.blob();
          zip.file(safeMp3Filename({ artist, title }), audioBlob, { binary: true });
          setProgress(((i + 1) / total) * 90);
          setStatus(`DOWNLOADED ${i + 1}/${total}`);
        }

        setStatus('CREATING ZIP...');
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        setProgress(100);
        saveAs(zipBlob, 'playlist.zip');
        setStatus('DOWNLOAD COMPLETE');
        return;
      }

      for (let i = 0; i < total; i++) {
        const track = tracks[i];
        setProgress(((i) / total) * 90);

        let audioBlob;
        let trackInfo = track;
        if (platform === 'soundcloud') {
          if (!track.media?.transcodings) {
            const trackRes = await fetch(`${WORKER_BASE}/tracks/${track.id}`);
            trackInfo = await trackRes.json();
          }
          const { artist, title } = getTrackMeta(trackInfo, i);
          setStatus(`TRACK ${i + 1}/${total}: ${artist} - ${title}`);
          const mp3 = trackInfo.media?.transcodings?.find(
            t => t.format?.protocol === 'progressive' && t.format?.mime_type === 'audio/mpeg'
          );
          if (!mp3) throw new Error(`No MP3 for "${title}"`);
          const downloadUrl = `${WORKER_BASE}/download?platform=soundcloud&url=${encodeURIComponent(mp3.url)}&artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
          const resp = await fetch(downloadUrl);
          if (!resp.ok) throw new Error('Download failed');
          audioBlob = await resp.blob();
        } else if (platform === 'youtube') {
          const { artist, title } = getTrackMeta(trackInfo, i);
          setStatus(`TRACK ${i + 1}/${total}: ${artist} - ${title}`);
          const downloadUrl = `${WORKER_BASE}/download?platform=youtube&trackId=${encodeURIComponent(track.id)}&artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`;
          const resp = await fetch(downloadUrl);
          if (!resp.ok) throw new Error('Download failed');
          audioBlob = await resp.blob();
        }
        zip.file(safeMp3Filename(getTrackMeta(trackInfo, i)), audioBlob, { binary: true });
        setProgress(((i + 1) / total) * 90);
      }

      setStatus('CREATING ZIP...');
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      setProgress(100);
      saveAs(zipBlob, 'playlist.zip');
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
