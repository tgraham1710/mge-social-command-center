/**
 * Stories Capture Module — MGE Social Command Center
 *
 * Stories on FB/IG live for 24h then disappear, taking their insights with them.
 * This module:
 *   1. Polls Meta Graph API for active IG + FB stories on a 12-hour interval
 *   2. Pulls per-story insights (reach, impressions, replies, navigation, follows, profile_visits, shares)
 *   3. Merges captures into a local archive (data/stories-archive.json) — same pattern as pulse-cache
 *   4. Commits the archive back to GitHub on a `data-archive` branch so it survives Render redeploys
 *      (Render only auto-deploys from main, so the archive branch doesn't trigger redeploys)
 *
 * Configuration (env vars, set in Render dashboard):
 *   FACEBOOK_PAGE_TOKEN     — Meta page access token (already set)
 *   FACEBOOK_PAGE_ID        — already set
 *   INSTAGRAM_TOKEN         — same token works; can be same as FACEBOOK_PAGE_TOKEN
 *   INSTAGRAM_USER_ID       — already set
 *   GITHUB_PAT              — fine-grained or classic PAT with `Contents: Read & Write` scope
 *                             on tgraham1710/mge-social-command-center
 *                             If absent, archive still saves locally; GitHub commit is skipped.
 *   GITHUB_ARCHIVE_BRANCH   — defaults to 'data-archive'
 *   GITHUB_REPO             — defaults to 'tgraham1710/mge-social-command-center'
 */

const fs = require('fs');
const path = require('path');

const META_BASE = 'https://graph.facebook.com/v22.0';
const ARCHIVE_DIR = path.join(__dirname, 'data');
const ARCHIVE_FILE = path.join(ARCHIVE_DIR, 'stories-archive.json');
const ARCHIVE_BRANCH = process.env.GITHUB_ARCHIVE_BRANCH || 'data-archive';
const ARCHIVE_REPO = process.env.GITHUB_REPO || 'tgraham1710/mge-social-command-center';
const ARCHIVE_PATH_IN_REPO = 'data/stories-archive.json';

// 12 hours
const POLL_INTERVAL_MS = 12 * 60 * 60 * 1000;

// v22 deprecated `impressions` for IG media — and Meta rejects the WHOLE bulk
// insights call when any single metric is invalid for a given media. So we keep
// the supported list small and use per-metric fallback (see fetchIgInsights below).
const IG_STORY_METRICS = [
  'reach',
  'views',
  'replies',
  'navigation',
  'follows',
  'profile_visits',
  'shares',
  'total_interactions'
];

function safeReadJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function ensureDirSync(d) {
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
}

function loadArchive() {
  return safeReadJSON(ARCHIVE_FILE, {
    version: 1,
    repo: ARCHIVE_REPO,
    lastUpdatedAt: null,
    stories: {}
  });
}

function saveArchiveLocal(archive) {
  ensureDirSync(ARCHIVE_DIR);
  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive, null, 2), 'utf8');
}

async function apiFetch(url, options = {}) {
  try {
    const resp = await fetch(url, options);
    if (!resp.ok) {
      const text = await resp.text();
      return { error: true, status: resp.status, message: text };
    }
    return await resp.json();
  } catch (err) {
    return { error: true, message: err.message };
  }
}

// Parse a single insights `data` array into the metrics map. Used by both bulk and
// per-metric fallback paths.
function _absorbIgInsights(insData, metrics, navState) {
  insData.forEach(m => {
    if (m.name === 'navigation') {
      const val = m.total_value || (m.values && m.values[0] && { value: m.values[0].value });
      if (val && Array.isArray(val.breakdowns) && val.breakdowns[0]) {
        navState.breakdown = (val.breakdowns[0].results || []).reduce((acc, r) => {
          acc[(r.dimension_values && r.dimension_values[0]) || 'unknown'] = r.value;
          return acc;
        }, {});
      }
      metrics.navigation = (val && (val.value !== undefined ? val.value : 0)) || 0;
    } else {
      let v = 0;
      if (m.values && m.values[0] && typeof m.values[0].value === 'number') v = m.values[0].value;
      else if (m.total_value && typeof m.total_value.value === 'number') v = m.total_value.value;
      metrics[m.name] = v;
    }
  });
}

// Fetch IG story insights with per-metric fallback. v22 returns 400 for the WHOLE
// bulk request if any metric isn't supported for the queried media (Reels vs.
// photo vs. video stories all have different supported metrics). When the bulk
// fails, we re-issue one request per metric and aggregate whatever works.
async function fetchIgInsights(storyId, accessToken) {
  const metrics = {};
  const navState = { breakdown: null };
  const errors = [];

  const bulkUrl = `${META_BASE}/${storyId}/insights?metric=${IG_STORY_METRICS.join(',')}&access_token=${accessToken}`;
  const bulk = await apiFetch(bulkUrl);
  if (bulk && Array.isArray(bulk.data) && bulk.data.length > 0) {
    _absorbIgInsights(bulk.data, metrics, navState);
    return { metrics, navigationBreakdown: navState.breakdown, errors };
  }
  if (bulk && bulk.error) errors.push({ stage: 'bulk', message: bulk.message });

  // Per-metric fallback
  await Promise.all(IG_STORY_METRICS.map(async (metric) => {
    const url = `${META_BASE}/${storyId}/insights?metric=${metric}&access_token=${accessToken}`;
    const r = await apiFetch(url);
    if (r && Array.isArray(r.data) && r.data.length > 0) {
      _absorbIgInsights(r.data, metrics, navState);
    } else if (r && r.error) {
      errors.push({ metric, message: r.message });
    }
  }));
  return { metrics, navigationBreakdown: navState.breakdown, errors };
}

async function fetchInstagramStories(config) {
  const { accessToken, igUserId } = config.instagram || {};
  if (!accessToken || !igUserId) {
    return { error: true, message: 'Instagram not configured' };
  }
  const listUrl = `${META_BASE}/${igUserId}/stories?fields=id,media_type,media_url,thumbnail_url,permalink,timestamp,caption&access_token=${accessToken}`;
  const list = await apiFetch(listUrl);
  if (list.error) return list;

  const items = list.data || [];
  const enriched = await Promise.all(items.map(async (s) => {
    const { metrics, navigationBreakdown, errors } = await fetchIgInsights(s.id, accessToken);
    return {
      platform: 'instagram',
      storyId: s.id,
      mediaType: s.media_type || null,
      mediaUrl: s.media_url || null,
      thumbnailUrl: s.thumbnail_url || s.media_url || null,
      permalink: s.permalink || null,
      caption: s.caption || '',
      postedAt: s.timestamp || null,
      capturedAt: new Date().toISOString(),
      metrics,
      navigationBreakdown,
      raw: errors.length ? { insightsErrors: errors } : undefined
    };
  }));
  return { stories: enriched };
}

// FB Page Story insights — Meta uses a COMPLETELY different metric set for
// stories vs. regular posts. The valid story metrics (per Meta's own error message)
// are listed below. We map each to a friendly key on the way out so the dashboard
// can use the same property names as IG ('reach', 'views', 'replies', etc.).
const FB_STORY_METRICS = [
  'page_story_impressions_by_story_id',          // total impressions
  'page_story_impressions_by_story_id_unique',   // unique reach
  'pages_fb_story_replies',                       // DM replies
  'pages_fb_story_shares',                        // shares
  'pages_fb_story_thread_lightweight_reactions',  // quick reactions
  'pages_fb_story_sticker_interactions',          // sticker interactions (polls/quizzes/etc)
  'story_interaction',                            // total interactions composite
  'story_media_view',                             // total story media views
  'story_total_media_view_unique'                 // unique story media views
];

// Map Meta's verbose metric names to friendlier keys the dashboard renders.
const FB_STORY_METRIC_ALIASES = {
  page_story_impressions_by_story_id: 'impressions',
  page_story_impressions_by_story_id_unique: 'reach',
  pages_fb_story_replies: 'replies',
  pages_fb_story_shares: 'shares',
  pages_fb_story_thread_lightweight_reactions: 'reactions',
  pages_fb_story_sticker_interactions: 'sticker_interactions',
  story_interaction: 'total_interactions',
  story_media_view: 'views',
  story_total_media_view_unique: 'unique_views'
};

function _absorbFbMetric(m, metrics) {
  const v = (m.values && m.values[0] && m.values[0].value);
  const numeric = (typeof v === 'number') ? v : 0;
  // Store under both the raw name AND the friendly alias so the rest of the
  // pipeline can look up either.
  metrics[m.name] = numeric;
  const alias = FB_STORY_METRIC_ALIASES[m.name];
  if (alias) metrics[alias] = numeric;
}

async function fetchFbInsights(postId, pageAccessToken) {
  const metrics = {};
  const errors = [];

  // Try bulk first — fast path when all metrics happen to apply
  const bulkUrl = `${META_BASE}/${postId}/insights?metric=${FB_STORY_METRICS.join(',')}&access_token=${pageAccessToken}`;
  const bulk = await apiFetch(bulkUrl);
  if (bulk && Array.isArray(bulk.data) && bulk.data.length > 0) {
    bulk.data.forEach(m => _absorbFbMetric(m, metrics));
    return { metrics, errors };
  }
  if (bulk && bulk.error) errors.push({ stage: 'bulk', message: bulk.message });

  // Per-metric fallback — story metric availability differs by media type
  // (image vs. video stories don't return identical metric sets), so a bulk
  // call with a metric that's invalid for THIS story type voids the whole
  // batch. Per-metric requests pick up everything that's actually available.
  await Promise.all(FB_STORY_METRICS.map(async (metric) => {
    const url = `${META_BASE}/${postId}/insights?metric=${metric}&access_token=${pageAccessToken}`;
    const r = await apiFetch(url);
    if (r && Array.isArray(r.data) && r.data.length > 0) {
      r.data.forEach(m => _absorbFbMetric(m, metrics));
    } else if (r && r.error) {
      errors.push({ metric, message: r.message });
    }
  }));
  return { metrics, errors };
}

// Meta returns FB story creation_time as either ISO ('2026-05-05T22:24:17+0000')
// or Unix seconds string ('1778022257'). Normalize to ISO.
function normalizeFbTime(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d+$/.test(s)) {
    const ms = (s.length <= 10) ? Number(s) * 1000 : Number(s);
    return new Date(ms).toISOString();
  }
  return s;
}

async function fetchFacebookStories(config) {
  const { pageAccessToken, pageId } = config.facebook || {};
  if (!pageAccessToken || !pageId) {
    return { error: true, message: 'Facebook not configured' };
  }
  // FB /{page-id}/stories returns post_id reliably but `id` is often missing,
  // and `media_url` is rarely populated — use attachments expansion for the thumbnail.
  const fields = [
    'id',
    'status',
    'media_type',
    'media_url',
    'creation_time',
    'expiration_time',
    'url',
    'post_id',
    'attachments{media_type,media{image{src},source},url,title,description}'
  ].join(',');
  const listUrl = `${META_BASE}/${pageId}/stories?fields=${encodeURIComponent(fields)}&access_token=${pageAccessToken}`;
  const list = await apiFetch(listUrl);
  if (list.error) return list;
  const items = list.data || [];

  const enriched = await Promise.all(items.map(async (s) => {
    // Pull thumbnail from attachments if media_url isn't returned (typical case)
    let mediaUrl = s.media_url || null;
    let thumbnailUrl = s.media_url || null;
    if (s.attachments && Array.isArray(s.attachments.data)) {
      const att = s.attachments.data[0];
      if (att && att.media && att.media.image && att.media.image.src) {
        thumbnailUrl = att.media.image.src;
        if (!mediaUrl && att.media.source) mediaUrl = att.media.source;
      }
    }

    let insightsResult = { metrics: {}, errors: [] };
    if (s.post_id) {
      insightsResult = await fetchFbInsights(s.post_id, pageAccessToken);
    }

    // FB stories don't always return `id` at the top level. Fall back to post_id
    // so the merge step has a stable archive key.
    const stableId = s.id || s.post_id || null;

    return {
      platform: 'facebook',
      storyId: stableId,
      postId: s.post_id || null,
      status: s.status || null,
      mediaType: s.media_type || null,
      mediaUrl,
      thumbnailUrl,
      permalink: s.url || null,
      caption: '',
      postedAt: normalizeFbTime(s.creation_time),
      expiresAt: normalizeFbTime(s.expiration_time),
      capturedAt: new Date().toISOString(),
      metrics: insightsResult.metrics,
      navigationBreakdown: null,
      raw: insightsResult.errors.length ? { insightsErrors: insightsResult.errors } : undefined
    };
  }));
  return { stories: enriched };
}

function mergeIntoArchive(archive, captures) {
  let added = 0, updated = 0;
  captures.forEach(c => {
    if (!c || !c.storyId) return;
    const key = `${c.platform}:${c.storyId}`;
    const existed = !!archive.stories[key];
    const existing = archive.stories[key] || {};
    archive.stories[key] = {
      ...existing,
      ...c,
      captureHistory: [
        ...(existing.captureHistory || []),
        { capturedAt: c.capturedAt, metrics: c.metrics, navigationBreakdown: c.navigationBreakdown }
      ].slice(-20)
    };
    if (existed) updated++; else added++;
  });
  archive.lastUpdatedAt = new Date().toISOString();
  return { added, updated };
}

async function ghApi(method, urlPath, token, body) {
  const url = `https://api.github.com${urlPath}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mge-social-command-center'
    }
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { rawText: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

async function ensureArchiveBranch(token) {
  const ref = await ghApi('GET', `/repos/${ARCHIVE_REPO}/git/refs/heads/${ARCHIVE_BRANCH}`, token);
  if (ref.ok) return { ok: true, created: false };
  if (ref.status !== 404) {
    return { ok: false, error: `Failed to check branch: ${ref.status} ${JSON.stringify(ref.data)}` };
  }
  const main = await ghApi('GET', `/repos/${ARCHIVE_REPO}/git/refs/heads/main`, token);
  if (!main.ok) return { ok: false, error: `Failed to read main ref: ${main.status} ${JSON.stringify(main.data)}` };
  const sha = main.data.object && main.data.object.sha;
  if (!sha) return { ok: false, error: 'Could not find main HEAD sha' };
  const create = await ghApi('POST', `/repos/${ARCHIVE_REPO}/git/refs`, token, {
    ref: `refs/heads/${ARCHIVE_BRANCH}`,
    sha
  });
  if (!create.ok) return { ok: false, error: `Failed to create branch: ${create.status} ${JSON.stringify(create.data)}` };
  return { ok: true, created: true };
}

async function commitArchiveToGitHub(archive) {
  const token = process.env.GITHUB_PAT;
  if (!token) {
    return { ok: false, skipped: true, reason: 'GITHUB_PAT not set; archive saved locally only' };
  }
  const branch = await ensureArchiveBranch(token);
  if (!branch.ok) return { ok: false, error: branch.error };

  let sha = null;
  const cur = await ghApi('GET', `/repos/${ARCHIVE_REPO}/contents/${ARCHIVE_PATH_IN_REPO}?ref=${ARCHIVE_BRANCH}`, token);
  if (cur.ok && cur.data && cur.data.sha) sha = cur.data.sha;
  else if (cur.status !== 404) {
    return { ok: false, error: `Failed to read archive file sha: ${cur.status} ${JSON.stringify(cur.data)}` };
  }

  const body = {
    message: `chore(stories): archive snapshot ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(archive, null, 2), 'utf8').toString('base64'),
    branch: ARCHIVE_BRANCH
  };
  if (sha) body.sha = sha;
  const put = await ghApi('PUT', `/repos/${ARCHIVE_REPO}/contents/${ARCHIVE_PATH_IN_REPO}`, token, body);
  if (!put.ok) return { ok: false, error: `Commit failed: ${put.status} ${JSON.stringify(put.data)}` };
  return { ok: true, commit: put.data && put.data.commit && put.data.commit.sha };
}

let _capturing = false;
let _lastResult = null;

async function runStoryCapture(config) {
  if (_capturing) return { ok: false, busy: true, message: 'Capture already in progress' };
  _capturing = true;
  const startedAt = new Date().toISOString();
  try {
    const [ig, fb] = await Promise.all([
      fetchInstagramStories(config),
      fetchFacebookStories(config)
    ]);
    const captures = [];
    if (!ig.error) captures.push(...(ig.stories || []));
    if (!fb.error) captures.push(...(fb.stories || []));

    const archive = loadArchive();
    const merge = mergeIntoArchive(archive, captures);
    saveArchiveLocal(archive);

    const gh = await commitArchiveToGitHub(archive);
    _lastResult = {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      activeNow: { instagram: ig.error ? null : (ig.stories || []).length, facebook: fb.error ? null : (fb.stories || []).length },
      errors: {
        instagram: ig.error ? ig.message : null,
        facebook: fb.error ? fb.message : null
      },
      archive: { added: merge.added, updated: merge.updated, totalArchived: Object.keys(archive.stories).length },
      github: gh
    };
    console.log(' [STORIES] Capture complete:', JSON.stringify(_lastResult));
    return _lastResult;
  } catch (err) {
    _lastResult = { ok: false, error: err.message, startedAt, finishedAt: new Date().toISOString() };
    console.error(' [STORIES] Capture failed:', err);
    return _lastResult;
  } finally {
    _capturing = false;
  }
}

function startStoryPoller(getConfig) {
  setTimeout(() => { runStoryCapture(getConfig()).catch(() => {}); }, 30 * 1000);
  setInterval(() => { runStoryCapture(getConfig()).catch(() => {}); }, POLL_INTERVAL_MS);
  console.log(` [STORIES] Poller started: every ${POLL_INTERVAL_MS / 3600000}h, archive branch '${ARCHIVE_BRANCH}'`);
}

function getLastResult() {
  return _lastResult;
}

module.exports = {
  fetchInstagramStories,
  fetchFacebookStories,
  loadArchive,
  runStoryCapture,
  startStoryPoller,
  getLastResult,
  POLL_INTERVAL_MS,
  ARCHIVE_FILE,
  ARCHIVE_BRANCH,
  ARCHIVE_REPO
};
