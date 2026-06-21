'use strict';

// integrations/youtubeChannelClient.js — READ-ONLY enumeration of a YouTube channel's
// videos and retrieval of their transcripts. It only reads public data; it never posts,
// comments, or writes anything anywhere.
//
// Two modes (so the pipeline runs with or without credentials):
//   • LIVE  — when YOUTUBE_API_KEY is set, enumerate via the YouTube Data API v3
//             (channels.list → uploads playlist → playlistItems.list). Transcripts are
//             NOT available through the Data API; supply a transcriptFetcher (e.g. a
//             yt-dlp/timedtext wrapper) via deps, or run offline.
//   • OFFLINE/INJECTED — pass { videos, transcripts } (or a local fixtures dir) so the
//             extraction pipeline can be exercised without network/keys.
//
// Live transcript scraping and the Data API call are intentionally injectable so this
// module stays testable and the rest of the app never hard-depends on network access.

const https = require('https');

const CHANNEL_HANDLE = process.env.KB_CHANNEL_HANDLE || '@dokumenty_pro';

// ─── Pure helpers ────────────────────────────────────────────────────────────
// parseVideoId — accept a raw id or any youtube URL form.
function parseVideoId(input) {
  const s = String(input || '');
  const m = s.match(/(?:v=|\/shorts\/|\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
}

function videoUrl(videoId) { return `https://www.youtube.com/watch?v=${videoId}`; }

function normalizeHandle(h) {
  const s = String(h || '').trim();
  return s.startsWith('@') ? s : `@${s.replace(/^.*\/@?/, '')}`;
}

// ─── Minimal HTTPS GET → JSON (used only in LIVE mode) ──────────────────────────
function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`bad JSON from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// enumerateVideos(deps) → { ok, channel, videos: [{ video_id, title, published_at, url, description }], reason? }
// deps.videos        — INJECTED/OFFLINE list (used as-is when provided).
// deps.apiKey        — override YOUTUBE_API_KEY.
// deps.getJson       — test seam for the HTTP layer.
async function enumerateVideos(deps = {}) {
  const channel = normalizeHandle(deps.channel || CHANNEL_HANDLE);

  // Offline / injected
  if (Array.isArray(deps.videos)) {
    return { ok: true, channel, source: 'injected', videos: deps.videos.map(normalizeVideo) };
  }

  const apiKey = deps.apiKey || process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return { ok: false, channel, source: 'live', reason: 'youtube_api_key_not_configured', videos: [] };
  }

  const _getJson = deps.getJson || getJson;
  try {
    // 1) resolve channel → uploads playlist id
    const chRes = await _getJson(
      `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(channel)}&key=${apiKey}`
    );
    const uploads = chRes?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return { ok: false, channel, source: 'live', reason: 'channel_not_found', videos: [] };

    // 2) page through the uploads playlist
    const videos = [];
    let pageToken = '';
    do {
      const plRes = await _getJson(
        `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${uploads}&key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ''}`
      );
      for (const it of (plRes.items || [])) {
        const sn = it.snippet || {};
        videos.push(normalizeVideo({
          video_id:    sn.resourceId?.videoId,
          title:       sn.title,
          published_at: sn.publishedAt,
          description: sn.description,
        }));
      }
      pageToken = plRes.nextPageToken || '';
    } while (pageToken);

    return { ok: true, channel, source: 'live', videos };
  } catch (err) {
    return { ok: false, channel, source: 'live', reason: 'fetch_failed', error: err.message, videos: [] };
  }
}

function normalizeVideo(v = {}) {
  const id = parseVideoId(v.video_id || v.id || v.url) || v.video_id || null;
  return {
    video_id:    id,
    title:       v.title || '',
    published_at: v.published_at ? new Date(v.published_at) : (v.publishedAt ? new Date(v.publishedAt) : null),
    url:         id ? videoUrl(id) : (v.url || ''),
    description: v.description || '',
    duration:    v.duration || '',
  };
}

// fetchTranscript(videoId, deps) → { ok, language, text } | { ok:false, reason }
// Transcripts are NOT in the Data API. deps.transcripts is a { [videoId]: text } map
// (offline), or deps.transcriptFetcher(videoId) returns { language, text }. Without
// either, returns a clear not-available result (the video is still inventoried).
async function fetchTranscript(videoId, deps = {}) {
  if (deps.transcripts && typeof deps.transcripts[videoId] === 'string') {
    return { ok: true, language: deps.language || 'ru', text: deps.transcripts[videoId] };
  }
  if (typeof deps.transcriptFetcher === 'function') {
    try {
      const r = await deps.transcriptFetcher(videoId);
      if (r && r.text) return { ok: true, language: r.language || 'ru', text: r.text };
      return { ok: false, reason: 'no_transcript' };
    } catch (err) {
      return { ok: false, reason: 'transcript_fetch_failed', error: err.message };
    }
  }
  return { ok: false, reason: 'no_transcript_source' };
}

module.exports = {
  CHANNEL_HANDLE,
  parseVideoId,
  videoUrl,
  normalizeHandle,
  normalizeVideo,
  enumerateVideos,
  fetchTranscript,
};
