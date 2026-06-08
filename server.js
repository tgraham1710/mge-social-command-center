/**
 * MGE Social Media Command Center - Backend Server
 * Proxies API calls to Facebook, Instagram, LinkedIn, and YouTube
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const pulse = require('./pulse');
const stories = require('./stories');
const app = express();
app.use(express.json());

function loadConfig() {
  const fileConfig = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
    catch (e) { return null; }
  })();
  const config = {
    youtube: {
      enabled: process.env.YOUTUBE_API_KEY ? true : fileConfig?.youtube?.enabled || false,
      apiKey: process.env.YOUTUBE_API_KEY || fileConfig?.youtube?.apiKey || '',
      channelId: process.env.YOUTUBE_CHANNEL_ID || fileConfig?.youtube?.channelId || ''
    },
    facebook: {
      enabled: process.env.FACEBOOK_PAGE_TOKEN ? true : fileConfig?.facebook?.enabled || false,
      appId: process.env.FACEBOOK_APP_ID || fileConfig?.facebook?.appId || '',
      pageAccessToken: process.env.FACEBOOK_PAGE_TOKEN || fileConfig?.facebook?.pageAccessToken || '',
      pageId: process.env.FACEBOOK_PAGE_ID || fileConfig?.facebook?.pageId || ''
    },
    instagram: {
      enabled: process.env.INSTAGRAM_TOKEN ? true : fileConfig?.instagram?.enabled || false,
      accessToken: process.env.INSTAGRAM_TOKEN || fileConfig?.instagram?.accessToken || '',
      igUserId: process.env.INSTAGRAM_USER_ID || fileConfig?.instagram?.igUserId || ''
    },
    linkedin: {
      enabled: process.env.LINKEDIN_TOKEN ? true : fileConfig?.linkedin?.enabled || false,
      accessToken: process.env.LINKEDIN_TOKEN || fileConfig?.linkedin?.accessToken || '',
      organizationId: process.env.LINKEDIN_ORG_ID || fileConfig?.linkedin?.organizationId || ''
    },
    googleReviews: {
      // Google Business Profile API (OAuth 2.0)
      // Credentials added to Render env vars once GBP API access is approved by Google.
      // Required env vars: GBP_CLIENT_ID, GBP_CLIENT_SECRET, GBP_REFRESH_TOKEN, GBP_ACCOUNT_NAME
      enabled: !!(process.env.GBP_CLIENT_ID && process.env.GBP_REFRESH_TOKEN),
      clientId:     process.env.GBP_CLIENT_ID     || fileConfig?.googleReviews?.clientId     || '',
      clientSecret: process.env.GBP_CLIENT_SECRET || fileConfig?.googleReviews?.clientSecret || '',
      refreshToken: process.env.GBP_REFRESH_TOKEN || fileConfig?.googleReviews?.refreshToken || '',
      // GBP account name format: "accounts/XXXXXXXXXX"
      accountName:  process.env.GBP_ACCOUNT_NAME  || fileConfig?.googleReviews?.accountName  || '',
      // GBP location name format: "locations/XXXXXXXXXX" (auto-discovered from account if omitted)
      locationName: process.env.GBP_LOCATION_NAME || fileConfig?.googleReviews?.locationName || ''
    },
    server: {
      port: parseInt(process.env.PORT || fileConfig?.server?.port || '3000', 10),
      refreshIntervalSeconds: fileConfig?.server?.refreshIntervalSeconds || 3600
    }
  };
  if (process.env.NODE_ENV !== 'production') {
    const usingEnv = !!(process.env.YOUTUBE_API_KEY || process.env.FACEBOOK_PAGE_TOKEN || process.env.INSTAGRAM_TOKEN || process.env.LINKEDIN_TOKEN);
    console.log(` Config source: ${usingEnv ? 'Environment variables' : 'config.json (or defaults)'}`);
  }
  return config;
}
let config = loadConfig();

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) config = loadConfig();
  next();
});

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const SESSION_TOKEN = DASHBOARD_PASSWORD ? Buffer.from('mge-auth-' + DASHBOARD_PASSWORD).toString('base64') : null;

// Rate limiting: track failed attempts per IP
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function isLockedOut(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return true;
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) { loginAttempts.delete(ip); return false; }
  return false;
}
function recordFailure(ip) {
  const rec = loginAttempts.get(ip) || { count: 0 };
  rec.count++;
  if (rec.count >= MAX_ATTEMPTS) rec.lockedUntil = Date.now() + LOCKOUT_MS;
  loginAttempts.set(ip, rec);
}
function clearAttempts(ip) { loginAttempts.delete(ip); }

// Visual CAPTCHA: random 5-char alphanumeric string
const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCaptchaText() {
  return Array.from({length: 5}, () => CAPTCHA_CHARS[Math.floor(Math.random() * CAPTCHA_CHARS.length)]).join('');
}
const captchas = new Map();
function newCaptchaToken(text) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  captchas.set(token, { ans: text.toUpperCase(), expires: Date.now() + 5 * 60 * 1000 });
  return token;
}
function validateCaptcha(token, guess) {
  const c = captchas.get(token);
  if (!c || Date.now() > c.expires) return false;
  captchas.delete(token);
  return (guess || '').toUpperCase().trim() === c.ans;
}

function loginPage(errorMsg, captchaText, captchaToken) {
  // Canvas CAPTCHA rendered client-side with the text embedded
  return `<!DOCTYPE html><html><head><title>MGE Audience Insights Hub</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a2744;display:flex;justify-content:center;align-items:center;min-height:100vh}.card{background:#fff;border-radius:12px;padding:40px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,0.3)}.logo{text-align:center;margin-bottom:28px}.logo h1{font-size:18px;font-weight:700;color:#0a2744;line-height:1.3}.logo p{font-size:13px;color:#666;margin-top:4px}label{display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:6px;margin-top:16px}input[type=password],input[type=text]{width:100%;padding:11px 14px;border:1.5px solid #ddd;border-radius:8px;font-size:15px;outline:none;transition:border-color .2s}input:focus{border-color:#0a2744}.captcha-wrap{display:flex;align-items:center;gap:10px;margin-top:6px}canvas{border-radius:6px;border:1.5px solid #ddd;flex-shrink:0}.refresh-btn{background:none;border:none;cursor:pointer;color:#0a2744;font-size:20px;padding:4px;line-height:1;width:auto;margin:0}input[type=text].captcha-input{flex:1}button[type=submit]{width:100%;margin-top:20px;padding:12px;background:#0a2744;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:background .2s}button[type=submit]:hover{background:#1a3d6e}.error{color:#c0392b;font-size:13px;margin-top:12px;text-align:center;padding:8px;background:#fdf0f0;border-radius:6px}</style></head><body><div class="card"><div class="logo"><h1>MGE Audience Insights Hub</h1><p>Madison Gas and Electric | Marketing &amp; Communications</p></div><form method="POST" action="/auth/login"><label for="pw">Password</label><input type="password" id="pw" name="pw" placeholder="Enter password" autofocus required><label>Security Check — type the characters you see</label><div class="captcha-wrap"><canvas id="cap" width="160" height="52"></canvas><button type="button" class="refresh-btn" onclick="drawCaptcha()" title="Refresh">↻</button></div><input type="text" class="captcha-input" name="captcha_ans" placeholder="Enter characters" required autocomplete="off" spellcheck="false"><input type="hidden" name="captcha_token" value="${captchaToken}">${errorMsg ? `<p class="error">${errorMsg}</p>` : ''}<button type="submit">Sign In</button></form></div><script>const CTEXT="${captchaText}";function drawCaptcha(){const c=document.getElementById('cap'),ctx=c.getContext('2d');const w=c.width,h=c.height;ctx.clearRect(0,0,w,h);// Background gradient
const g=ctx.createLinearGradient(0,0,w,h);g.addColorStop(0,'#e8eef7');g.addColorStop(1,'#d0daea');ctx.fillStyle=g;ctx.fillRect(0,0,w,h);// Noise dots
for(let i=0;i<80;i++){ctx.fillStyle='rgba('+Math.floor(Math.random()*100)+','+Math.floor(Math.random()*100)+','+Math.floor(Math.random()*150)+',0.3)';ctx.beginPath();ctx.arc(Math.random()*w,Math.random()*h,Math.random()*2,0,Math.PI*2);ctx.fill()}// Interference lines
for(let i=0;i<4;i++){ctx.strokeStyle='rgba('+Math.floor(Math.random()*80)+','+Math.floor(Math.random()*80)+','+Math.floor(Math.random()*120)+',0.4)';ctx.lineWidth=1+Math.random();ctx.beginPath();ctx.moveTo(Math.random()*w,Math.random()*h);ctx.bezierCurveTo(Math.random()*w,Math.random()*h,Math.random()*w,Math.random()*h,Math.random()*w,Math.random()*h);ctx.stroke()}// Draw each character with random rotation and position jitter
const fonts=['Arial','Georgia','Verdana','Courier New'];const colors=['#0a2744','#1a3d6e','#8b0000','#006400','#4b0082'];ctx.textBaseline='middle';const cw=w/CTEXT.length;for(let i=0;i<CTEXT.length;i++){ctx.save();const x=cw*i+cw/2;const y=h/2+(Math.random()*8-4);ctx.translate(x,y);ctx.rotate((Math.random()-0.5)*0.5);ctx.font=(22+Math.floor(Math.random()*8))+'px '+fonts[Math.floor(Math.random()*fonts.length)];ctx.fillStyle=colors[Math.floor(Math.random()*colors.length)];ctx.fillText(CTEXT[i],0,0);ctx.restore()}}drawCaptcha();</script></body></html>`;
}

if (DASHBOARD_PASSWORD) {
  app.use(express.urlencoded({ extended: false }));

  // Login form
  app.get('/auth/login', (req, res) => {
    const text = makeCaptchaText();
    const token = newCaptchaToken(text);
    res.send(loginPage('', text, token));
  });

  // Login POST
  app.post('/auth/login', (req, res) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

    if (isLockedOut(ip)) {
      const text = makeCaptchaText();
      return res.send(loginPage('Too many failed attempts. Please wait 15 minutes.', text, newCaptchaToken(text)));
    }

    const captchaOk = validateCaptcha(req.body.captcha_token, req.body.captcha_ans?.trim());
    if (!captchaOk) {
      recordFailure(ip);
      const text = makeCaptchaText();
      return res.send(loginPage('Incorrect security characters. Please try again.', text, newCaptchaToken(text)));
    }

    if (req.body.pw !== DASHBOARD_PASSWORD) {
      recordFailure(ip);
      const text = makeCaptchaText();
      return res.send(loginPage('Incorrect password. Please try again.', text, newCaptchaToken(text)));
    }

    clearAttempts(ip);
    res.setHeader('Set-Cookie', `mge_auth=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`);
    return res.redirect('/');
  });

  // Auth middleware — protect everything except login routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/auth/')) return next();
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => { const [k,...v]=c.trim().split('='); return [k, v.join('=')]; }));
    if (cookies.mge_auth === SESSION_TOKEN) return next();
    return res.redirect('/auth/login');
  });
}

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'MGE_Social_Command_Center.html')));

async function apiFetch(url, options = {}) {
  try {
    const resp = await fetch(url, options);
    if (!resp.ok) {
      const text = await resp.text();
      const isQuota = resp.status === 403 && text.toLowerCase().includes('quota');
      if (isQuota) console.warn(' [!] API quota exceeded for: ' + url.split('?')[0]);
      return { error: true, status: resp.status, message: text, quotaExceeded: isQuota };
    }
    return await resp.json();
  } catch (err) {
    return { error: true, message: err.message };
  }
}

app.get('/api/status', (req, res) => {
  res.json({
    youtube: !!(config.youtube?.enabled && config.youtube?.apiKey && config.youtube?.channelId),
    facebook: !!(config.facebook?.enabled && config.facebook?.pageAccessToken && config.facebook?.pageId),
    instagram: !!(config.instagram?.enabled && config.instagram?.accessToken && config.instagram?.igUserId),
    linkedin: !!(config.linkedin?.enabled && config.linkedin?.accessToken && config.linkedin?.organizationId),
    refreshInterval: config.server?.refreshIntervalSeconds || 3600,
    // Public FB App ID (not a secret — shown in every OAuth URL). Exposed so the
    // dashboard can assemble OAuth dialog URLs for token regeneration.
    facebookAppId: config.facebook?.appId || null
  });
});

function dateRangeParams(req) {
  const since = req.query.since;
  const until = req.query.until;
  let qs = '';
  if (since) qs += '&since=' + encodeURIComponent(since);
  if (until) qs += '&until=' + encodeURIComponent(until);
  return qs;
}

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

app.get('/api/youtube/channel', async (req, res) => {
  const { apiKey, channelId } = config.youtube || {};
  if (!apiKey || !channelId) return res.json({ error: true, message: 'YouTube not configured' });
  const data = await apiFetch(`${YT_BASE}/channels?part=snippet,statistics,brandingSettings&id=${channelId}&key=${apiKey}`);
  res.json(data);
});

app.get('/api/youtube/videos', async (req, res) => {
  const { apiKey, channelId } = config.youtube || {};
  if (!apiKey || !channelId) return res.json({ error: true, message: 'YouTube not configured' });
  const channelData = await apiFetch(`${YT_BASE}/channels?part=contentDetails&id=${channelId}&key=${apiKey}`);
  if (channelData.error) return res.json(channelData);
  const uploadsId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) return res.json({ error: true, message: 'No uploads playlist found' });
  const playlist = await apiFetch(`${YT_BASE}/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=50&key=${apiKey}`);
  if (playlist.error) return res.json(playlist);
  const videoIds = playlist.items?.map(i => i.snippet.resourceId.videoId).join(',');
  if (!videoIds) return res.json({ items: [] });
  const videos = await apiFetch(`${YT_BASE}/videos?part=snippet,statistics&id=${videoIds}&key=${apiKey}`);
  res.json(videos);
});

app.get('/api/youtube/comments/:videoId', async (req, res) => {
  const { apiKey } = config.youtube || {};
  if (!apiKey) return res.json({ error: true, message: 'YouTube not configured' });
  // part=snippet,replies returns up to 5 replies per thread inline (item.replies.comments[])
  const data = await apiFetch(`${YT_BASE}/commentThreads?part=snippet,replies&videoId=${req.params.videoId}&maxResults=50&order=time&key=${apiKey}`);
  res.json(data);
});

app.get('/api/youtube/all-comments', async (req, res) => {
  const { apiKey, channelId } = config.youtube || {};
  if (!apiKey || !channelId) return res.json({ error: true, message: 'YouTube not configured' });
  const channelData = await apiFetch(`${YT_BASE}/channels?part=contentDetails&id=${channelId}&key=${apiKey}`);
  if (channelData.error) return res.json(channelData);
  const uploadsId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  const playlist = await apiFetch(`${YT_BASE}/playlistItems?part=snippet&playlistId=${uploadsId}&maxResults=20&key=${apiKey}`);
  if (playlist.error) return res.json(playlist);
  const videoIds = playlist.items?.map(i => i.snippet.resourceId.videoId) || [];
  // part=snippet,replies returns up to ~5 inline replies per thread for free; deeper threads
  // would need a per-thread /comments?parentId= follow-up but that would burn quota fast.
  const commentPromises = videoIds.map(vid =>
    apiFetch(`${YT_BASE}/commentThreads?part=snippet,replies&videoId=${vid}&maxResults=50&order=time&key=${apiKey}`)
  );
  const results = await Promise.all(commentPromises);
  const allComments = [];
  results.forEach((r, i) => {
    if (!r.error && r.items) {
      r.items.forEach(item => {
        const c = item.snippet.topLevelComment.snippet;
        const parentCommentId = item.snippet.topLevelComment.id;
        allComments.push({
          platform: 'youtube',
          id: parentCommentId,
          author: c.authorDisplayName,
          authorImage: c.authorProfileImageUrl,
          text: c.textDisplay,
          publishedAt: c.publishedAt,
          likeCount: c.likeCount,
          videoId: videoIds[i],
          videoTitle: playlist.items[i]?.snippet?.title || ''
        });
        // Threaded replies (item.replies.comments[]) — flatten so they count just like top-level comments
        const replies = item.replies?.comments || [];
        replies.forEach(reply => {
          const rs = reply.snippet || {};
          allComments.push({
            platform: 'youtube',
            id: reply.id,
            author: rs.authorDisplayName,
            authorImage: rs.authorProfileImageUrl,
            text: rs.textDisplay,
            publishedAt: rs.publishedAt,
            likeCount: rs.likeCount || 0,
            videoId: videoIds[i],
            videoTitle: playlist.items[i]?.snippet?.title || '',
            isReply: true,
            parentCommentId: parentCommentId,
            parentAuthor: c.authorDisplayName || '',
            parentCommentText: c.textDisplay || ''
          });
        });
      });
    }
  });
  allComments.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  res.json({ comments: allComments });
});

const META_BASE = 'https://graph.facebook.com/v22.0';

app.get('/api/facebook/page', async (req, res) => {
  const { pageAccessToken, pageId } = config.facebook || {};
  if (!pageAccessToken || !pageId) return res.json({ error: true, message: 'Facebook not configured' });
  const data = await apiFetch(`${META_BASE}/${pageId}?fields=id,name,fan_count,followers_count,picture,about,engagement&access_token=${pageAccessToken}`);
  res.json(data);
});

app.get('/api/facebook/posts', async (req, res) => {
  const { pageAccessToken, pageId } = config.facebook || {};
  if (!pageAccessToken || !pageId) return res.json({ error: true, message: 'Facebook not configured' });
  // Post-level insights metrics confirmed working via /facebook/posts-insights-diag (2026-05-04):
  // post_impressions_unique = unique people who saw THIS post (used as cross-post impressions proxy
  // because Meta deprecated post_impressions). post_clicks = link/CTA clicks. post_video_views = video plays.
  // We deliberately do NOT request post_impressions / post_engaged_users / post_clicks_unique
  // (all return error #100 — silently kills the entire posts response if included).
  let url = `${META_BASE}/${pageId}/posts?fields=id,message,created_time,full_picture,permalink_url,status_type,shares,reactions.summary(true),reactions.type(LIKE).limit(0).summary(total_count).as(reactions_like),reactions.type(LOVE).limit(0).summary(total_count).as(reactions_love),reactions.type(WOW).limit(0).summary(total_count).as(reactions_wow),reactions.type(HAHA).limit(0).summary(total_count).as(reactions_haha),reactions.type(SAD).limit(0).summary(total_count).as(reactions_sad),reactions.type(ANGRY).limit(0).summary(total_count).as(reactions_angry),reactions.type(CARE).limit(0).summary(total_count).as(reactions_care),comments.summary(true),insights.metric(post_impressions_unique,post_clicks,post_video_views)&limit=50&access_token=${pageAccessToken}`;
  url += dateRangeParams(req);
  const data = await apiFetch(url);
  res.json(data);
});

// DIAGNOSTIC — probes post-level insights metrics on a recent post one at a time
// to identify which ones Meta still supports. Visit /api/facebook/posts-insights-diag.
app.get('/api/facebook/posts-insights-diag', async (req, res) => {
  const { pageAccessToken, pageId } = config.facebook || {};
  if (!pageAccessToken || !pageId) return res.json({ error: true, message: 'Facebook not configured' });
  // Grab one recent post to test against
  const postsResp = await apiFetch(`${META_BASE}/${pageId}/posts?fields=id,created_time&limit=1&access_token=${pageAccessToken}`);
  const samplePost = (postsResp && postsResp.data && postsResp.data[0]) || null;
  if (!samplePost) return res.json({ ok: false, error: 'Could not fetch a sample post', postsResp });
  const candidates = [
    'post_impressions',
    'post_impressions_unique',
    'post_impressions_organic',
    'post_impressions_organic_unique',
    'post_impressions_paid',
    'post_impressions_paid_unique',
    'post_engaged_users',
    'post_clicks',
    'post_clicks_unique',
    'post_video_views',
    'post_video_views_unique',
    'post_reactions_by_type_total'
  ];
  const results = await Promise.all(candidates.map(async (m) => {
    const r = await apiFetch(`${META_BASE}/${samplePost.id}/insights?metric=${m}&access_token=${pageAccessToken}`);
    if (r && r.error) {
      let detail = '';
      try {
        const inner = JSON.parse(r.message || '{}');
        detail = (inner.error && (inner.error.message || inner.error.code)) || '';
      } catch (e) { detail = r.message || ''; }
      return { metric: m, ok: false, error: detail.toString().slice(0, 160) };
    }
    const arr = (r && r.data) || [];
    const sample = arr[0] || {};
    return { metric: m, ok: true, value: sample.values && sample.values[0] && sample.values[0].value };
  }));
  res.json({
    ok: true,
    note: 'Each post-level insights metric tested individually against a single recent post.',
    samplePostId: samplePost.id,
    samplePostCreated: samplePost.created_time,
    results
  });
});

app.get('/api/facebook/comments/:postId', async (req, res) => {
  const { pageAccessToken } = config.facebook || {};
  if (!pageAccessToken) return res.json({ error: true, message: 'Facebook not configured' });
  // Include nested comments{} so threaded replies come back in one round-trip
  // 'from' omitted — see all-comments endpoint note above
  const data = await apiFetch(`${META_BASE}/${req.params.postId}/comments?fields=id,message,created_time,like_count,comment_count,comments.limit(50){id,message,created_time,like_count,parent}&limit=50&order=reverse_chronological&access_token=${pageAccessToken}`);
  res.json(data);
});

app.get('/api/facebook/all-comments', async (req, res) => {
  const { pageAccessToken, pageId } = config.facebook || {};
  if (!pageAccessToken || !pageId) return res.json({ error: true, message: 'Facebook not configured' });
  // IMPORTANT NOTES ON META GRAPH API GOTCHAS:
  // 1. 'from' field omitted — Graph API v13+ silently drops the entire comments edge if included.
  // 2. '.order()' is NOT valid in nested field expansion — also causes silent failure. Use only as
  //    a direct query param on /{post-id}/comments calls.
  // 3. Nested comment field expansion in the /posts query (comments.limit(100){...}) causes Meta's
  //    complexity budget to kick in, silently reducing page size from 100 to ~21 posts.
  //
  // STRATEGY:
  // Phase 1 — Fetch post metadata ONLY (no nested comments) so we get the full 100 posts/page.
  //   Include updated_time: Facebook updates this field when new comments are posted, so old posts
  //   with recent comments will have a recent updated_time and bubble up in Phase 2 sorting.
  //   Paginate up to 10 pages × 100 = 1000 posts.
  // Phase 2 — Sort all posts by updated_time desc (most recently active first — this surfaces old
  //   posts that got new comments). Fetch reverse-chronological comments for the top 50 posts in
  //   parallel. order=reverse_chronological is valid as a direct query param.
  // Final — Deduplicate by comment ID, sort all by publishedAt desc.

  const seenIds = new Set();
  const allComments = [];
  const allPosts = [];
  let postCount = 0;

  function pushComment(obj) {
    if (obj.id && !seenIds.has(obj.id)) { seenIds.add(obj.id); allComments.push(obj); }
  }

  // ── Phase 1: paginate through posts (bare fields — no nested comments) ──────
  // Bare fields prevent Meta's complexity budget from reducing page size.
  // updated_time lets us find old posts that have new recent comments.
  let nextUrl = `${META_BASE}/${pageId}/posts?fields=id,message,created_time,updated_time,full_picture,permalink_url&limit=100&access_token=${pageAccessToken}`;

  for (let page = 0; page < 10 && nextUrl; page++) {
    const postsData = await apiFetch(nextUrl);
    if (postsData.error) {
      if (page === 0) {
        console.error('[FB Comments] Posts fetch error:', JSON.stringify(postsData).substring(0, 300));
        return res.json(postsData);
      }
      break;
    }
    (postsData.data || []).forEach(post => {
      postCount++;
      allPosts.push({
        postId: post.id,
        postMessage: post.message || '',
        postImage: post.full_picture || '',
        postUrl: post.permalink_url || '',
        createdTime: post.created_time,
        updatedTime: post.updated_time || post.created_time
      });
    });
    nextUrl = postsData.paging?.next || null;
  }

  // ── Phase 2: fetch reverse-chronological comments for top 50 most-active posts ─
  // Sort by updated_time desc: old posts with new comments will have a recent updatedTime
  // and float to the top, solving the "recent reply on an old post" problem.
  allPosts.sort((a, b) => new Date(b.updatedTime) - new Date(a.updatedTime));
  const postsToCheck = allPosts.slice(0, 50);

  // order=reverse_chronological IS valid as a direct query param (NOT in nested field expansion)
  await Promise.all(postsToCheck.map(async (meta) => {
    const url = `${META_BASE}/${meta.postId}/comments?fields=id,message,created_time,like_count,comments.limit(50){id,message,created_time,like_count}&order=reverse_chronological&limit=100&access_token=${pageAccessToken}`;
    const data = await apiFetch(url);
    if (data.error) return;
    (data.data || []).forEach(c => {
      pushComment({ platform: 'facebook', id: c.id, author: 'Facebook commenter', text: c.message, publishedAt: c.created_time, likeCount: c.like_count || 0, ...meta });
      (c.comments?.data || []).forEach(r => {
        pushComment({ platform: 'facebook', id: r.id, author: 'Facebook commenter', text: r.message, publishedAt: r.created_time, likeCount: r.like_count || 0, ...meta, isReply: true, parentCommentId: c.id, parentCommentText: c.message || '' });
      });
    });
  }));

  console.log(`[FB Comments] ${postCount} posts fetched, ${postsToCheck.length} checked for comments, ${allComments.length} unique comments`);
  allComments.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  res.json({ comments: allComments });
});

app.get('/api/facebook/insights', async (req, res) => {
  const { pageAccessToken, pageId } = config.facebook || {};
  if (!pageAccessToken || !pageId) return res.json({ error: true, message: 'Facebook not configured' });
  // Curated to ONLY metrics confirmed working via /api/facebook/insights-diag (2026-05-04).
  // Meta deprecated: page_impressions, page_engaged_users, page_fan_adds, page_fan_adds_unique, page_followers.
  // Total impressions now derived per-post from /facebook/posts insights expansion.
  const metrics = 'page_impressions_unique,page_post_engagements,page_views_total,page_video_views,page_video_views_unique';
  const data = await apiFetch(`${META_BASE}/${pageId}/insights?metric=${metrics}&period=day&date_preset=last_30d&access_token=${pageAccessToken}`);
  res.json(data);
});

// DIAGNOSTIC — tries each FB page-insights metric individually so we can see which ones still work
// after Meta's periodic deprecations. Visit /api/facebook/insights-diag to get a per-metric report.
app.get('/api/facebook/insights-diag', async (req, res) => {
  const { pageAccessToken, pageId } = config.facebook || {};
  if (!pageAccessToken || !pageId) return res.json({ error: true, message: 'Facebook not configured' });
  // Candidates — anything currently or recently used in the dashboard, plus likely replacements
  const candidates = [
    'page_impressions',           // total impressions
    'page_impressions_unique',    // reach (unique people) — possibly deprecated
    'page_engaged_users',         // possibly deprecated
    'page_post_engagements',      // total reactions/comments/shares/clicks on posts
    'page_fan_adds',              // new page likes
    'page_fan_adds_unique',       // possibly deprecated
    'page_views_total',           // possibly deprecated
    'page_total_actions',         // replacement for page_views_total in newer API versions
    'page_video_views',           // total video views
    'page_video_views_unique',    // possibly deprecated
    'page_followers',             // current follower count
  ];
  const results = await Promise.all(candidates.map(async (m) => {
    const url = `${META_BASE}/${pageId}/insights?metric=${m}&period=day&date_preset=last_30d&access_token=${pageAccessToken}`;
    const r = await apiFetch(url);
    if (r && r.error) {
      let detail = '';
      try {
        const inner = JSON.parse(r.message || '{}');
        detail = (inner.error && (inner.error.message || inner.error.code)) || '';
      } catch (e) { detail = r.message || ''; }
      return { metric: m, ok: false, error: detail.toString().slice(0, 160) };
    }
    const arr = (r && r.data) || [];
    const sample = arr[0] || {};
    const totalValue = (sample.values || []).reduce((s, v) => s + (Number(v.value) || 0), 0);
    return { metric: m, ok: true, period: sample.period, points: (sample.values || []).length, total_30d: totalValue };
  }));
  res.json({
    ok: true,
    note: 'Each metric tested individually. ok:false = deprecated or unavailable for this token.',
    pageId,
    apiVersion: META_BASE.match(/v\d+\.\d+/)[0],
    results
  });
});

// DIAGNOSTIC — checks IG token scopes + tries account-level insights to see which permissions are missing
app.get('/api/instagram/diag', async (req, res) => {
  const { accessToken, igUserId } = config.instagram || {};
  if (!accessToken || !igUserId) return res.json({ error: true, message: 'Instagram not configured' });
  const out = {};
  // 1) Token introspection — what scopes does this token have?
  const tokenInfo = await apiFetch(`https://graph.facebook.com/v22.0/debug_token?input_token=${accessToken}&access_token=${accessToken}`);
  out.tokenScopes = (tokenInfo && tokenInfo.data && tokenInfo.data.scopes) || [];
  out.tokenIsValid = (tokenInfo && tokenInfo.data && tokenInfo.data.is_valid) || false;
  out.tokenAppId = (tokenInfo && tokenInfo.data && tokenInfo.data.app_id) || null;
  // 2) Try account-level insights endpoint — separate from media insights
  const acctIns = await apiFetch(`${META_BASE}/${igUserId}/insights?metric=reach&period=day&access_token=${accessToken}`);
  out.accountInsightsTest = acctIns && acctIns.error ? { ok: false, error: acctIns.message } : { ok: true, sample: acctIns };
  // 3) Try media insights with field expansion (current dashboard call)
  const mediaIns = await apiFetch(`${META_BASE}/${igUserId}/media?fields=id,timestamp,media_type,insights.metric(reach)&limit=3&access_token=${accessToken}`);
  out.mediaInsightsTest = mediaIns && mediaIns.error ? { ok: false, error: mediaIns.message } : { ok: true, sampleCount: (mediaIns.data || []).length };
  // 4) Recommendations
  const needed = ['instagram_basic', 'instagram_manage_insights'];
  const missing = needed.filter(s => !out.tokenScopes.includes(s));
  out.missingScopes = missing;
  out.recommendation = missing.length
    ? 'Token is missing scope(s): ' + missing.join(', ') + '. Generate a new long-lived token via Meta Graph API Explorer with these permissions, then update INSTAGRAM_ACCESS_TOKEN on Render.'
    : 'All required scopes present. If insights still error, the IG account may not be linked to a Business Page in Meta Business Suite.';
  res.json(out);
});

app.get('/api/instagram/profile', async (req, res) => {
  const { accessToken, igUserId } = config.instagram || {};
  if (!accessToken || !igUserId) return res.json({ error: true, message: 'Instagram not configured' });
  const data = await apiFetch(`${META_BASE}/${igUserId}?fields=id,name,username,profile_picture_url,followers_count,follows_count,media_count,biography&access_token=${accessToken}`);
  res.json(data);
});

app.get('/api/instagram/media', async (req, res) => {
  const { accessToken, igUserId } = config.instagram || {};
  if (!accessToken || !igUserId) return res.json({ error: true, message: 'Instagram not configured' });
  let url = `${META_BASE}/${igUserId}/media?fields=id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&limit=50&access_token=${accessToken}`;
  if (req.query.since) { const sinceUnix = Math.floor(new Date(req.query.since).getTime() / 1000); url += '&since=' + sinceUnix; }
  if (req.query.until) { const untilUnix = Math.floor(new Date(req.query.until).getTime() / 1000); url += '&until=' + untilUnix; }
  const data = await apiFetch(url);
  res.json(data);
});

app.get('/api/instagram/comments/:mediaId', async (req, res) => {
  const { accessToken } = config.instagram || {};
  if (!accessToken) return res.json({ error: true, message: 'Instagram not configured' });
  // IG calls nested replies "replies" (not "comments"). Add field expansion to grab them in one shot.
  const data = await apiFetch(`${META_BASE}/${req.params.mediaId}/comments?fields=id,text,timestamp,username,like_count,replies.limit(50){id,text,timestamp,username,like_count}&limit=50&access_token=${accessToken}`);
  res.json(data);
});

app.get('/api/instagram/all-comments', async (req, res) => {
  const { accessToken, igUserId } = config.instagram || {};
  if (!accessToken || !igUserId) return res.json({ error: true, message: 'Instagram not configured' });

  // STRATEGY (mirrors the FB two-phase approach — same complexity budget issue):
  // Phase 1 — Fetch media with BARE fields only (no nested comments).
  //   Nesting comments{} inside /media hits Meta's complexity budget and silently
  //   reduces page size from 50 to ~10, causing nearly all posts to be skipped.
  //   Bare fields return the full 50/page and we paginate to scan more posts.
  // Phase 2 — For each post, fetch comments via the direct /{mediaId}/comments
  //   endpoint. This is a dedicated comments query (not nested), so the complexity
  //   budget is independent of the media fetch. Replies are included inline here
  //   because this is a direct comments call — that's safe.

  const seenIds = new Set();
  const allComments = [];
  const allMedia = [];
  let mediaCount = 0;

  function pushComment(obj) {
    if (obj.id && !seenIds.has(obj.id)) { seenIds.add(obj.id); allComments.push(obj); }
  }

  // ── Phase 1: paginate through IG media (bare fields — no nested comments) ──
  let phase1Base = `${META_BASE}/${igUserId}/media?fields=id,caption,media_url,thumbnail_url,timestamp&limit=50&access_token=${accessToken}`;
  if (req.query.since) { phase1Base += '&since=' + Math.floor(new Date(req.query.since).getTime() / 1000); }
  let nextUrl = phase1Base;

  for (let page = 0; page < 6 && nextUrl; page++) {
    const mediaData = await apiFetch(nextUrl);
    if (mediaData.error) {
      if (page === 0) {
        console.error('[IG Comments] Media fetch error:', JSON.stringify(mediaData).substring(0, 300));
        return res.json(mediaData);
      }
      break;
    }
    (mediaData.data || []).forEach(post => {
      mediaCount++;
      allMedia.push({
        postId: post.id,
        postCaption: post.caption || '',
        postImage: post.media_url || post.thumbnail_url || '',
        timestamp: post.timestamp
      });
    });
    nextUrl = mediaData.paging?.next || null;
  }

  // ── Phase 2: fetch comments for the most recent 50 posts ──────────────────
  // IG has no updated_time equivalent, so we use timestamp (creation time) and
  // scan the freshest posts. Comments on old IG posts are rare vs. FB.
  allMedia.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const postsToCheck = allMedia.slice(0, 50);

  await Promise.all(postsToCheck.map(async (meta) => {
    // Replies are safe to include inline here — this is a direct /comments query,
    // not nested inside a /media expansion, so complexity budget is separate.
    const url = `${META_BASE}/${meta.postId}/comments?fields=id,text,timestamp,username,like_count,replies.limit(50){id,text,timestamp,username,like_count}&limit=100&access_token=${accessToken}`;
    const data = await apiFetch(url);
    if (data.error) return;
    (data.data || []).forEach(c => {
      pushComment({
        platform: 'instagram', id: c.id, author: c.username || 'Instagram User',
        text: c.text, publishedAt: c.timestamp, likeCount: c.like_count || 0,
        postId: meta.postId, postCaption: meta.postCaption, postImage: meta.postImage
      });
      (c.replies?.data || []).forEach(r => {
        pushComment({
          platform: 'instagram', id: r.id, author: r.username || 'Instagram User',
          text: r.text, publishedAt: r.timestamp, likeCount: r.like_count || 0,
          postId: meta.postId, postCaption: meta.postCaption, postImage: meta.postImage,
          isReply: true, parentCommentId: c.id, parentAuthor: c.username || '',
          parentCommentText: c.text || ''
        });
      });
    });
  }));

  console.log(`[IG Comments] ${mediaCount} posts fetched, ${postsToCheck.length} checked for comments, ${allComments.length} unique comments`);
  allComments.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  res.json({ comments: allComments });
});

app.get('/api/instagram/reach', async (req, res) => {
  const { accessToken, igUserId } = config.instagram || {};
  if (!accessToken || !igUserId) return res.json({ error: true, message: 'Instagram not configured' });
  // Meta deprecated `impressions` for IG accounts in April 2024 — replaced with `views` for video/reels.
  // We request all three: API returns whichever applies per media type (reach for everything;
  // impressions for legacy photo posts; views for video/reels). Frontend sums what's present.
  // media_product_type distinguishes REELS from regular VIDEO posts for the Content Type Mix section.
  let url = `${META_BASE}/${igUserId}/media?fields=id,timestamp,media_type,media_product_type,insights.metric(reach,views,impressions)&limit=50&access_token=${accessToken}`;
  if (req.query.since) { const sinceUnix = Math.floor(new Date(req.query.since).getTime() / 1000); url += '&since=' + sinceUnix; }
  if (req.query.until) { const untilUnix = Math.floor(new Date(req.query.until).getTime() / 1000); url += '&until=' + untilUnix; }
  const data = await apiFetch(url);
  res.json(data);
});

const LI_BASE = 'https://api.linkedin.com/v2';
const LI_REST = 'https://api.linkedin.com/rest';

app.get('/api/linkedin/organization', async (req, res) => {
  const { accessToken, organizationId } = config.linkedin || {};
  if (!accessToken || !organizationId) return res.json({ error: true, message: 'LinkedIn not configured' });
  const data = await apiFetch(
    `${LI_BASE}/organizations/${organizationId}?projection=(id,localizedName,vanityName,logoV2,followersCount)`,
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'LinkedIn-Version': '202503', 'X-Restli-Protocol-Version': '2.0.0' } }
  );
  res.json(data);
});

app.get('/api/linkedin/follower-count', async (req, res) => {
  const { accessToken, organizationId } = config.linkedin || {};
  if (!accessToken || !organizationId) return res.json({ error: true, message: 'LinkedIn not configured' });
  const data = await apiFetch(
    `${LI_BASE}/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=urn:li:organization:${organizationId}`,
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'LinkedIn-Version': '202503', 'X-Restli-Protocol-Version': '2.0.0' } }
  );
  res.json(data);
});

app.get('/api/linkedin/posts', async (req, res) => {
  const { accessToken, organizationId } = config.linkedin || {};
  if (!accessToken || !organizationId) return res.json({ error: true, message: 'LinkedIn not configured' });
  const data = await apiFetch(
    `${LI_REST}/posts?author=urn:li:organization:${organizationId}&q=author&count=50&sortBy=LAST_MODIFIED`,
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'LinkedIn-Version': '202503' } }
  );
  res.json(data);
});

app.get('/api/linkedin/social-actions/:postUrn', async (req, res) => {
  const { accessToken } = config.linkedin || {};
  if (!accessToken) return res.json({ error: true, message: 'LinkedIn not configured' });
  const urn = decodeURIComponent(req.params.postUrn);
  const [likes, comments] = await Promise.all([
    apiFetch(`${LI_REST}/socialActions/${encodeURIComponent(urn)}/likes?count=50`, { headers: { 'Authorization': `Bearer ${accessToken}`, 'LinkedIn-Version': '202503' } }),
    apiFetch(`${LI_REST}/socialActions/${encodeURIComponent(urn)}/comments?count=50`, { headers: { 'Authorization': `Bearer ${accessToken}`, 'LinkedIn-Version': '202503' } })
  ]);
  res.json({ likes, comments });
});

app.get('/api/linkedin/page-stats', async (req, res) => {
  const { accessToken, organizationId } = config.linkedin || {};
  if (!accessToken || !organizationId) return res.json({ error: true, message: 'LinkedIn not configured' });
  const data = await apiFetch(
    `${LI_REST}/organizationPageStatistics?q=organization&organization=urn:li:organization:${organizationId}`,
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'LinkedIn-Version': '202503' } }
  );
  res.json(data);
});

app.get('/api/linkedin/all-comments', async (req, res) => {
  const { accessToken, organizationId } = config.linkedin || {};
  if (!accessToken || !organizationId) return res.json({ error: true, message: 'LinkedIn not configured' });
  const liHeaders = { 'Authorization': `Bearer ${accessToken}`, 'LinkedIn-Version': '202503' };
  const postsData = await apiFetch(
    `${LI_REST}/posts?author=urn:li:organization:${organizationId}&q=author&count=50&sortBy=LAST_MODIFIED`,
    { headers: liHeaders }
  );
  if (postsData.error) return res.json(postsData);
  const posts = postsData.elements || [];
  // Pass 1: fetch top-level comments for each post
  const commentPromises = posts.map(p =>
    apiFetch(`${LI_REST}/socialActions/${encodeURIComponent(p.id)}/comments?count=50`, { headers: liHeaders })
  );
  const results = await Promise.all(commentPromises);
  const allComments = [];
  // Build a list of (postIndex, comment) pairs, and collect comment URNs that may have replies
  const replyTargets = []; // { postIndex, commentUrn, parentAuthor }
  results.forEach((r, i) => {
    if (!r.error && r.elements) {
      r.elements.forEach(c => {
        const commentUrn = c.$URN || c.object?.$URN || null;
        allComments.push({
          platform: 'linkedin',
          id: commentUrn || (posts[i].id + ':' + (c.created?.time || '')),
          author: c.actor?.name || 'LinkedIn User',
          text: c.message?.text || c.comment || '',
          publishedAt: c.created?.time ? new Date(c.created.time).toISOString() : new Date().toISOString(),
          likeCount: c.likeCount || 0,
          postId: posts[i].id,
          postText: posts[i].commentary || posts[i].specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text || ''
        });
        // Queue a reply fetch for this comment if we have a URN to target.
        if (commentUrn) {
          replyTargets.push({
            postIndex: i,
            commentUrn,
            parentAuthor: c.actor?.name || '',
            parentText: c.message?.text || c.comment || ''
          });
        }
      });
    }
  });
  // Pass 2: fetch second-level replies for every top-level comment that exposed a URN.
  // Capped at 100 reply-fetches per refresh to keep this bounded.
  const cappedTargets = replyTargets.slice(0, 100);
  const replyResults = await Promise.all(
    cappedTargets.map(t =>
      apiFetch(`${LI_REST}/socialActions/${encodeURIComponent(t.commentUrn)}/comments?count=20`, { headers: liHeaders })
    )
  );
  replyResults.forEach((rr, idx) => {
    const t = cappedTargets[idx];
    if (!rr || rr.error || !rr.elements) return;
    rr.elements.forEach(rc => {
      const replyUrn = rc.$URN || rc.object?.$URN || null;
      allComments.push({
        platform: 'linkedin',
        id: replyUrn || (t.commentUrn + ':' + (rc.created?.time || '')),
        author: rc.actor?.name || 'LinkedIn User',
        text: rc.message?.text || rc.comment || '',
        publishedAt: rc.created?.time ? new Date(rc.created.time).toISOString() : new Date().toISOString(),
        likeCount: rc.likeCount || 0,
        postId: posts[t.postIndex].id,
        postText: posts[t.postIndex].commentary || posts[t.postIndex].specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text || '',
        isReply: true,
        parentCommentId: t.commentUrn,
        parentAuthor: t.parentAuthor,
        parentCommentText: t.parentText || ''
      });
    });
  });
  allComments.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  res.json({ comments: allComments });
});

app.get('/api/all-data', async (req, res) => {
  const status = {
    youtube: !!(config.youtube?.enabled && config.youtube?.apiKey),
    facebook: !!(config.facebook?.enabled && config.facebook?.pageAccessToken),
    instagram: !!(config.instagram?.enabled && config.instagram?.accessToken),
    linkedin: !!(config.linkedin?.enabled && config.linkedin?.accessToken)
  };
  const port = config.server?.port || 3000;
  const fetches = {};
  if (status.youtube) {
    fetches.youtubeChannel = apiFetch(`http://localhost:${port}/api/youtube/channel`);
    fetches.youtubeVideos = apiFetch(`http://localhost:${port}/api/youtube/videos`);
    fetches.youtubeComments = apiFetch(`http://localhost:${port}/api/youtube/all-comments`);
  }
  if (status.facebook) {
    fetches.facebookPage = apiFetch(`http://localhost:${port}/api/facebook/page`);
    fetches.facebookPosts = apiFetch(`http://localhost:${port}/api/facebook/posts`);
    fetches.facebookComments = apiFetch(`http://localhost:${port}/api/facebook/all-comments`);
    fetches.facebookInsights = apiFetch(`http://localhost:${port}/api/facebook/insights`);
  }
  if (status.instagram) {
    fetches.instagramProfile = apiFetch(`http://localhost:${port}/api/instagram/profile`);
    fetches.instagramMedia = apiFetch(`http://localhost:${port}/api/instagram/media`);
    fetches.instagramComments = apiFetch(`http://localhost:${port}/api/instagram/all-comments`);
    fetches.instagramReach = apiFetch(`http://localhost:${port}/api/instagram/reach`);
  }
  if (status.linkedin) {
    fetches.linkedinOrg = apiFetch(`http://localhost:${port}/api/linkedin/organization`);
    fetches.linkedinPosts = apiFetch(`http://localhost:${port}/api/linkedin/posts`);
    fetches.linkedinComments = apiFetch(`http://localhost:${port}/api/linkedin/all-comments`);
    fetches.linkedinPageStats = apiFetch(`http://localhost:${port}/api/linkedin/page-stats`);
  }
  const keys = Object.keys(fetches);
  const values = await Promise.all(Object.values(fetches));
  const result = { status };
  keys.forEach((k, i) => result[k] = values[i]);
  res.json(result);
});


// ============================================================
// GOOGLE BUSINESS PROFILE REVIEWS
// OAuth 2.0 refresh-token flow → mybusinessreviews.googleapis.com
// Required env vars: GBP_CLIENT_ID, GBP_CLIENT_SECRET,
//                    GBP_REFRESH_TOKEN, GBP_ACCOUNT_NAME
// Optional:          GBP_LOCATION_NAME (auto-discovered if omitted)
// ============================================================

let _gbpAccessToken = null;
let _gbpTokenExpiry  = 0;
let _gbpLocationName = null; // cached after first discovery
let _gbpReviewsCache     = null;
let _gbpReviewsCacheTime = 0;
const GBP_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const GBP_STAR_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

async function _gbpGetAccessToken() {
  if (_gbpAccessToken && Date.now() < _gbpTokenExpiry - 60000) return _gbpAccessToken;
  const cfg = config.googleReviews;
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    throw new Error('GBP OAuth credentials not configured');
  }
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type:    'refresh_token'
    })
  });
  if (!resp.ok) throw new Error('GBP token refresh failed: ' + (await resp.text()));
  const data = await resp.json();
  _gbpAccessToken = data.access_token;
  _gbpTokenExpiry = Date.now() + (data.expires_in * 1000);
  return _gbpAccessToken;
}

async function _gbpGetLocationName(accessToken) {
  if (_gbpLocationName) return _gbpLocationName;
  const envLoc = config.googleReviews?.locationName;
  if (envLoc) { _gbpLocationName = envLoc; return _gbpLocationName; }
  const accountName = config.googleReviews?.accountName;
  if (!accountName) throw new Error('GBP_ACCOUNT_NAME not configured');
  const resp = await fetch(
    `https://mybusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name`,
    { headers: { Authorization: 'Bearer ' + accessToken } }
  );
  if (!resp.ok) throw new Error('Failed to list GBP locations: HTTP ' + resp.status);
  const data = await resp.json();
  const locs = data.locations || [];
  if (!locs.length) throw new Error('No GBP locations found under ' + accountName);
  _gbpLocationName = locs[0].name; // e.g. "locations/123456789"
  console.log('[GBP] Auto-discovered location:', _gbpLocationName);
  return _gbpLocationName;
}

app.get('/api/reviews', async (req, res) => {
  // Not yet configured — return pending so the frontend shows the waiting state
  if (!config.googleReviews?.enabled) {
    return res.json({ pending: true });
  }
  try {
    // Serve cached data if still fresh
    if (_gbpReviewsCache && (Date.now() - _gbpReviewsCacheTime) < GBP_CACHE_TTL) {
      return res.json(_gbpReviewsCache);
    }
    const token    = await _gbpGetAccessToken();
    const location = await _gbpGetLocationName(token);

    // Paginate up to 3 pages (max 150 reviews)
    let allReviews = [];
    let pageToken  = null;
    let page       = 0;
    do {
      const url = new URL(`https://mybusinessreviews.googleapis.com/v1/${location}/reviews`);
      url.searchParams.set('pageSize', '50');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const r = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) throw new Error('GBP Reviews API ' + r.status + ': ' + (await r.text()));
      const d = await r.json();
      // Normalize starRating from string ("FIVE") to integer (5)
      (d.reviews || []).forEach(review => {
        review.starRating = GBP_STAR_MAP[review.starRating] || 0;
      });
      allReviews = allReviews.concat(d.reviews || []);
      pageToken  = d.nextPageToken || null;
      page++;
    } while (pageToken && page < 3);

    const result = { locationName: location, reviews: allReviews };
    _gbpReviewsCache     = result;
    _gbpReviewsCacheTime = Date.now();
    console.log(`[GBP] Fetched ${allReviews.length} reviews for ${location}`);
    res.json(result);
  } catch (err) {
    console.error('[GBP Reviews]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MEDIA MONITORING & MENTIONS
// Adds /api/mentions + 5 source pollers (Reddit, Google Alerts,
// GDELT, YouTube keyword search, local news RSS). All polling
// runs in-process on staggered intervals; results cached in memory.
// ============================================================

const Parser = require('rss-parser');
// Browser-like User-Agent. Our previous custom UA was being blocked by TownNews /
// Cloudflare sites (WKOW, Channel 3000, Wisconsin State Journal, Cap Times all
// returned 429 rate-limited). Mainstream browser UAs get through these filters.
const FEED_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const rssParser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': FEED_USER_AGENT,
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
  },
  customFields: {
    item: [
      ['media:thumbnail', 'mediaThumbnail'],
      ['media:content', 'mediaContent'],
      ['content:encoded', 'contentEncoded'],
      ['og:image', 'ogImage']
    ]
  }
});

// Fetch + parse an RSS feed with a single retry on 429 (rate-limited).
// TownNews-powered Wisconsin outlets (WKOW, madison.com, captimes.com, etc.)
// occasionally return 429 on the first hit and succeed on a quick retry.
// Throws the original error if the retry also fails.
async function parseFeedResilient(url) {
  const doFetch = async () => {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': FEED_USER_AGENT,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      // 15 second cap — don't let a slow feed hold up the whole poll
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined
    });
    return resp;
  };
  let resp = await doFetch();
  if (resp.status === 429) {
    // Brief jittered backoff, then retry once
    const waitMs = 2500 + Math.floor(Math.random() * 1500);
    await new Promise(r => setTimeout(r, waitMs));
    resp = await doFetch();
  }
  if (!resp.ok) {
    const err = new Error('Status code ' + resp.status);
    err.code = 'HTTP_' + resp.status;
    throw err;
  }
  const body = await resp.text();
  return rssParser.parseString(body);
}

// --- Image/thumbnail extraction helpers ---
function firstImgFromHtml(html) {
  if (!html) return null;
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function imageFromRssItem(item) {
  // enclosure (standard)
  if (item.enclosure && item.enclosure.url && (!item.enclosure.type || /^image\//i.test(item.enclosure.type))) {
    return item.enclosure.url;
  }
  // media:thumbnail and media:content (rss-parser exposes attributes as $ object)
  const mt = item.mediaThumbnail;
  if (mt) {
    if (typeof mt === 'string') return mt;
    if (mt.$ && mt.$.url) return mt.$.url;
    if (Array.isArray(mt) && mt[0] && mt[0].$) return mt[0].$.url;
  }
  const mc = item.mediaContent;
  if (mc) {
    if (typeof mc === 'string') return mc;
    if (mc.$ && mc.$.url && (!mc.$.medium || mc.$.medium === 'image')) return mc.$.url;
    if (Array.isArray(mc)) {
      for (const c of mc) {
        if (c && c.$ && c.$.url && (!c.$.medium || c.$.medium === 'image')) return c.$.url;
      }
    }
  }
  // Inline <img> in content:encoded or content
  const img = firstImgFromHtml(item.contentEncoded) || firstImgFromHtml(item.content);
  if (img) return img;
  return null;
}

// --- Job listing filters (exclude MGE job postings/career listings) ---
const JOB_URL_PATTERNS = /(jobs?\.mge|careers?\.mge|\/careers?\/|\/jobs?\/|\/job-openings|indeed\.com|glassdoor\.com\/job|ziprecruiter\.com|monster\.com|simplyhired\.com|linkedin\.com\/jobs|jobvite\.com|myworkdayjobs\.com|greenhouse\.io|lever\.co|icims\.com|taleo\.net|ultipro\.com|paylocity\.com|adp\.com\/careers|smartrecruiters\.com|bamboohr\.com\/jobs|recruiting\.\w+\.(com|org))/i;
const JOB_TEXT_PATTERNS = /\b(apply (now|today|online|here)|job (opening|openings|posting|postings|description|id)|now hiring|we'?re hiring|hiring for|currently hiring|open position|open positions|current openings|join (our|the) team|career opportunit(y|ies)|employment opportunit(y|ies)|full[- ]?time position|part[- ]?time position|equal opportunity employer|competitive (salary|benefits|pay)|salary range|compensation range|pay range: \$|\$\d+[\s\S]{0,20}per (hour|year))\b/i;

function isJobListing(m) {
  try {
    if (m.url && JOB_URL_PATTERNS.test(m.url)) return true;
  } catch {}
  const text = (m.title || '') + ' ' + (m.snippet || '');
  if (JOB_TEXT_PATTERNS.test(text)) return true;
  return false;
}

// --- Brand keyword matching with Wisconsin geo-disambiguation ---
const UTILITY_CONTEXT = /\b(outage|power|electric|gas|utility|bill|rate|customer|energy|meter|grid|blackout|restoration|substation|transformer|kilowatt|kwh|solar|renewable)\b/i;
const WISCONSIN_GEO = /\b(Wisconsin|Madison|Dane County|Sun Prairie|Middleton|Fitchburg|Monona|Verona|Waunakee|Stoughton|Cottage Grove|McFarland|Milwaukee|Green Bay|Appleton|Eau Claire|Kenosha|Racine|Oshkosh|Janesville|La Crosse)\b/i;

// Brand configurations: each utility, with strict patterns and optional ambiguous+context disambiguation
// "requiresContext" means the text must ALSO mention utility terms or the utility's service-area geo
// (used to filter out false positives like sports arenas, stock tickers, unrelated orgs)
const BRANDS = {
  mge: {
    exact: [/\bMadison Gas and Electric\b/i, /\bMadison Gas & Electric\b/i, /\bMG&E\b/i, /\bMGE Energy\b/i],
    ambiguous: /\bMGE\b/,
    negative: /\bMGE Wealth|MGE Group|Mitsubishi|MGE Capital\b/i,
    requiresContext: true,
    contextRegex: null // uses default UTILITY_CONTEXT + WISCONSIN_GEO
  },
  alliant: {
    exact: [/\bAlliant Energy\b/i, /\bAlliant Energy Corporation\b/i, /\bInterstate Power (and|&) Light\b/i, /\bWisconsin Power (and|&) Light\b/i],
    ambiguous: null,
    negative: /\bAlliant International|Alliant University|Alliant Insurance|Alliant Credit Union|Alliant Techsystems|Alliant Capital\b/i,
    requiresContext: false,
    contextRegex: null
  },
  we_energies: {
    exact: [/\bWe Energies\b/i, /\bWisconsin Electric Power\b/i, /\bWEC Energy Group\b/i, /\bWisconsin Gas LLC\b/i],
    ambiguous: null,
    negative: null,
    requiresContext: false,
    contextRegex: null
  }
  // Xcel Energy intentionally removed — was surfacing inappropriate / off-topic content
  // (stock-bot signals, sports-arena references). Can be re-added later with stricter rules.
};

// Domains to exclude from all brand matching (stock signal bots, content farms, etc.)
const EXCLUDED_DOMAINS = /(getagraph\.com|tickercrunch|marketbeat\.com\/stock-ideas|zacks\.com\/stock\/news|simplywall\.st|insidermonkey\.com|stockstotrade|stocknews\.com|stockinvest|nasdaq\.com\/articles\/.*stock|benzinga\.com\/quote|fool\.com\/quote)/i;

// Strict energy/utility signal — for topical items to be accepted, their text must hit one of these.
// Broad enough to catch industry trends (renewables, solar, grid mod, EVs, decarbonization)
// but specific enough to filter out political/general news.
const TOPICAL_STRICT_SIGNALS = /\b(power outage|power outages|outage|outages|no power|blackout|blackouts|kilowatt|kwh|megawatt|mwh|solar panels?|solar install\w*|solar array|rooftop solar|solar company|solar companies|solar energy|solar power|solar farm|solar farms|utility[- ]scale solar|community solar|solar rebate|solar incentive|solar tariff|install solar|going solar|heat pump|heat pumps|ev charger|ev chargers|ev charging|electric vehicle|electric vehicles|electric vehicle charg\w+|charging station\w*|utility bill|utility bills|electric bill|electric bills|gas bill|gas bills|rate increase|rate hike|rate case|rate filing|net metering|time[- ]of[- ]use|tou rate|focus on energy|smart meter|smart meters|smart grid|grid modern\w+|grid reliability|electric grid|substation|transformer|public service commission|psc wisconsin|natural gas|nuclear plant|point beach|kewaunee|small modular reactor|\bsmr\b|wind farm|wind farms|wind turbine|wind turbines|wind energy|wind power|offshore wind|renewable energy|renewable power|renewables|clean energy|clean power|green energy|energy efficiency|weatherization|energy assistance|liheap|shut off|shutoff|power restored|power restoration|battery storage|energy storage|grid[- ]scale battery|lithium battery|demand response|virtual power plant|distributed energy|distributed generation|microgrid|microgrids|electrification|beneficial electrification|net zero|net[- ]zero|decarbonization|decarboniz\w+|carbon capture|carbon neutral|clean hydrogen|hydrogen fuel|hydrogen power|power purchase agreement|\bppa\b|energy transition|green hydrogen|grid stability|peak demand|load shed\w+|inflation reduction act|ira tax credit|investment tax credit|production tax credit)\b/i;

// Political/general-news noise — if topical text matches this AND doesn't have strong utility signal,
// reject it (catches Tammy Baldwin, election coverage, general Madison news).
const POLITICAL_NOISE = /\b(tammy baldwin|ron johnson|tony evers|derrick van orden|gwen moore|mark pocan|kamala harris|donald trump|joe biden|senator|congressm\w+|congresswom\w+|state assembly|state senator|state representative|election\w*|campaign\w*|primary|midterm|partisan|ballot|voter|voting|poll\w*|house of representatives|gubernatorial|state capitol|governor's office|state of the union|impeach\w+|indict\w+|supreme court|scotus)\b/i;

function verifyTopicalContent(text) {
  if (!text) return false;
  const hasStrictSignal = TOPICAL_STRICT_SIGNALS.test(text);
  if (!hasStrictSignal) return false;
  // Even with strict signal, if political noise dominates, reject
  const signalMatches = (text.match(new RegExp(TOPICAL_STRICT_SIGNALS.source, 'gi')) || []).length;
  const politicalMatches = (text.match(new RegExp(POLITICAL_NOISE.source, 'gi')) || []).length;
  // Require at least as many strict signals as political references
  if (politicalMatches > signalMatches) return false;
  return true;
}

// --- US geography gate for topical content ---------------------------------
// Non-US country/region signals — if these show up prominently we drop the item.
const NON_US_SIGNAL = /\b(ukraine|ukrainian|russia|russian|china|chinese|beijing|india|indian|pakistan|pakistani|u\.?k\.?|britain|british|england|english|scotland|scottish|wales|welsh|ireland|irish|germany|german|france|french|italy|italian|spain|spanish|portugal|portuguese|netherlands|dutch|amsterdam|belgium|belgian|poland|polish|sweden|swedish|norway|norwegian|finland|finnish|denmark|danish|europe|european union|\beu\b|brussels|brexit|australia|australian|new zealand|japan|japanese|tokyo|korea|korean|seoul|vietnam|indonesia|philippines|thailand|malaysia|singapore|taiwan|israel|israeli|iran|iranian|iraq|iraqi|saudi|saudi arabia|uae|united arab emirates|egypt|egyptian|turkey|turkish|south africa|nigeria|nigerian|kenya|kenyan|brazil|brazilian|mexico|mexican|argentina|chile|colombia|canada|canadian|ontario|quebec|alberta|toronto|vancouver|montreal)\b/i;

// US geography/institutional signals — at least one of these must be present
// for a topical item to pass the geo gate (WISCONSIN_GEO is already defined above).
const US_SIGNAL = /\b(u\.?s\.?|u\.?s\.?a\.?|united states|america|american|americans|federal|ferc|\bepa\b|\bdoe\b|department of energy|nerc|\binl\b|nrel|sandia|midwest|midwestern|great lakes|pjm|miso|ercot|caiso|spp|nypa|tva|bpa|minnesota|minnesotan|illinois|iowa|iowan|michigan|indiana|ohio|missouri|north dakota|south dakota|kansas|nebraska|kentucky|tennessee|texas|texan|california|californian|new york|new yorker|florida|floridian|pennsylvania|washington state|oregon|oregonian|colorado|arizona|nevada|georgia|virginia|north carolina|south carolina|alabama|mississippi|louisiana|arkansas|oklahoma|utah|montana|wyoming|idaho|new mexico|maine|vermont|new hampshire|massachusetts|connecticut|rhode island|new jersey|delaware|maryland|west virginia|hawaii|alaska|chicago|minneapolis|saint paul|st\.? paul|detroit|cleveland|columbus|cincinnati|indianapolis|st\.? louis|saint louis|kansas city|omaha|des moines|dallas|houston|austin|atlanta|boston|philadelphia|pittsburgh|los angeles|san francisco|san diego|seattle|portland|denver|phoenix|las vegas|miami|orlando|tampa|nashville|memphis|new orleans|washington d\.?c\.?|capitol hill)\b/i;

function verifyTopicalGeography(text) {
  if (!text) return false;
  // Hard-reject if a non-US country/region is in the first 120 chars (usually the title/lede)
  const firstChunk = text.slice(0, 120);
  if (NON_US_SIGNAL.test(firstChunk)) return false;
  // Soft-reject if non-US is mentioned 2+ times across the full text
  const nonUsMatches = (text.match(new RegExp(NON_US_SIGNAL.source, 'gi')) || []).length;
  if (nonUsMatches >= 2) return false;
  // Require a US/state/Wisconsin signal somewhere in the text
  return US_SIGNAL.test(text) || WISCONSIN_GEO.test(text);
}

// Identify which brand a piece of text matches (if any)
// Returns { brand, keyword, confidence } or null
//
// Signature: matchesAnyBrand(text, url, [title])
//   - text: full text (usually title + body combined)
//   - url: source URL for domain blacklist check
//   - title: (optional) when provided, enables title-aware mode for news feeds.
//            Title match = high confidence, single pass. Body-only match requires
//            2+ mentions to filter out "related articles" footer-link noise.
//            When omitted (Reddit, YouTube), old single-pass behavior applies.
function matchesAnyBrand(text, url, title) {
  if (!text) return null;
  // Domain exclusion first — skip stock-signal and low-quality sources entirely
  if (url && EXCLUDED_DOMAINS.test(url)) return null;

  const titleAware = (typeof title === 'string' && title.length > 0);
  const titleText = titleAware ? title : '';

  for (const [tag, cfg] of Object.entries(BRANDS)) {
    if (cfg.negative && cfg.negative.test(text)) continue;

    // Exact match (strong brand signal)
    for (const p of cfg.exact) {
      let matchedKeyword = null;
      let matchConfidence = 'high';
      let matchedInTitle = false;

      if (titleAware) {
        // Title-aware mode: title match is authoritative.
        const tm = titleText.match(p);
        if (tm) {
          matchedKeyword = tm[0];
          matchedInTitle = true;
        } else {
          // Not in title — require 2+ occurrences in full text to accept
          // (single body match is usually a footer/related-articles link)
          const globalP = new RegExp(p.source, 'gi');
          const allMatches = text.match(globalP) || [];
          if (allMatches.length >= 2) {
            matchedKeyword = allMatches[0];
            matchConfidence = 'medium';
          }
        }
      } else {
        // Legacy single-match mode (Reddit self-posts, YouTube descriptions)
        const m = text.match(p);
        if (m) matchedKeyword = m[0];
      }

      if (matchedKeyword) {
        // Some brands (Xcel) require context — still enforce
        if (cfg.requiresContext && cfg.contextRegex) {
          const u = UTILITY_CONTEXT.test(text);
          const g = cfg.contextRegex.test(text);
          if (!u && !g) continue;
          return { brand: tag, keyword: matchedKeyword, confidence: (u && g) ? 'high' : matchConfidence };
        }
        return { brand: tag, keyword: matchedKeyword, confidence: matchConfidence };
      }
    }

    // Ambiguous match (needs context disambiguation)
    if (cfg.ambiguous && cfg.ambiguous.test(text)) {
      const u = UTILITY_CONTEXT.test(text);
      const ctxRegex = cfg.contextRegex || WISCONSIN_GEO;
      const g = ctxRegex.test(text);
      if (u || g) {
        // In title-aware mode, also require that the ambiguous term appears in title
        // OR multiple times in body (single body mention is almost always a footer link)
        if (titleAware) {
          const inTitle = cfg.ambiguous.test(titleText);
          if (!inTitle) {
            const globalA = new RegExp(cfg.ambiguous.source, 'gi');
            const allMatches = text.match(globalA) || [];
            if (allMatches.length < 2) continue;
          }
        }
        const keyword = (text.match(cfg.ambiguous) || [tag])[0];
        return { brand: tag, keyword: keyword, confidence: (u && g) ? 'high' : 'medium' };
      }
    }
  }
  return null;
}

// Backwards-compatible alias (MGE-only match) used by existing pollers
function matchesBrand(text) {
  const m = matchesAnyBrand(text);
  if (!m || m.brand !== 'mge') return null;
  return { keyword: m.keyword, confidence: m.confidence };
}

// --- In-memory cache (no DB, intentional for free-tier footprint) ---
const MENTIONS = {
  items: [],
  lastPoll: {},
  stats: { reddit: 0, google_alerts: 0, gdelt: 0, youtube_search: 0, local_news: 0, google_news: 0, industry_news: 0, sec_filings: 0, podcasts: 0 },
  brandStats: { mge: 0, alliant: 0, we_energies: 0, topical: 0 },
  maxSize: 800
};

function addMentions(source, incoming) {
  MENTIONS.lastPoll[source] = new Date().toISOString();
  if (!incoming || incoming.length === 0) return 0;
  // Filter out job postings/careers listings
  const beforeJob = incoming.length;
  incoming = incoming.filter(m => !isJobListing(m));
  const jobSkipped = beforeJob - incoming.length;
  if (jobSkipped > 0) console.log(' [MENTIONS] ' + source + ': filtered ' + jobSkipped + ' job listing(s)');
  // Dedupe within incoming by id (the same item can match multiple poll queries)
  const seen = new Set();
  incoming = incoming.filter(i => {
    if (!i || !i.id) return false;
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });
  const existing = new Set(MENTIONS.items.map(m => m.id));
  const additions = incoming.filter(i => !existing.has(i.id));
  if (additions.length === 0) return 0;
  MENTIONS.items = [...additions, ...MENTIONS.items]
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, MENTIONS.maxSize);
  MENTIONS.stats[source] = (MENTIONS.stats[source] || 0) + additions.length;
  for (const a of additions) {
    const bt = a.brandTag || 'mge';
    MENTIONS.brandStats[bt] = (MENTIONS.brandStats[bt] || 0) + 1;
  }
  console.log(' [MENTIONS] ' + source + ': +' + additions.length + ' (cache total: ' + MENTIONS.items.length + ')');
  return additions.length;
}

function cleanHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// --- 1. Reddit (no-auth public JSON endpoints) ---
// Tagged queries: each entry carries a default brandTag for all matches.
// Brand queries still run through matchesAnyBrand() for verification; topical
// queries are scoped to Wisconsin subs and accepted without strict brand match.
const REDDIT_QUERIES = [
  // --- MGE brand (high priority, full year) ---
  { url: 'https://www.reddit.com/r/madisonwi+wisconsin+madison+greenbay+milwaukee+Appleton+EauClaire+LaCrosse/search.json?q=%22Madison+Gas+and+Electric%22+OR+%22MG%26E%22+OR+MGE&restrict_sr=1&sort=new&limit=25&t=year', tag: 'mge', requireBrand: true },
  { url: 'https://www.reddit.com/search.json?q=%22Madison+Gas+and+Electric%22+OR+%22MG%26E%22&sort=new&limit=25&t=year', tag: 'mge', requireBrand: true },
  // --- Competitors ---
  { url: 'https://www.reddit.com/r/wisconsin+milwaukee+madisonwi+greenbay+Appleton/search.json?q=%22Alliant+Energy%22&restrict_sr=1&sort=new&limit=20&t=year', tag: 'alliant', requireBrand: true },
  { url: 'https://www.reddit.com/search.json?q=%22Alliant+Energy%22+Wisconsin&sort=new&limit=20&t=year', tag: 'alliant', requireBrand: true },
  { url: 'https://www.reddit.com/r/wisconsin+milwaukee+madisonwi+greenbay+Appleton/search.json?q=%22We+Energies%22&restrict_sr=1&sort=new&limit=20&t=year', tag: 'we_energies', requireBrand: true },
  { url: 'https://www.reddit.com/search.json?q=%22We+Energies%22&sort=new&limit=20&t=year', tag: 'we_energies', requireBrand: true },
  // --- Topical (scoped to WI subs; surface for context even without brand name) ---
  { url: 'https://www.reddit.com/r/madisonwi+wisconsin+madison+milwaukee+greenbay/search.json?q=%22power+outage%22+OR+%22power+out%22+OR+blackout+OR+%22no+power%22&restrict_sr=1&sort=new&limit=20&t=month', tag: 'topical', requireBrand: false },
  { url: 'https://www.reddit.com/r/madisonwi+wisconsin+madison+milwaukee/search.json?q=%22solar+energy%22+OR+%22solar+panels%22+OR+%22solar+company%22+OR+%22solar+install%22+OR+%22go+solar%22+OR+%22rooftop+solar%22+OR+%22solar+farm%22+OR+%22community+solar%22&restrict_sr=1&sort=new&limit=20&t=year', tag: 'topical', requireBrand: false },
  { url: 'https://www.reddit.com/r/madisonwi+wisconsin+madison+milwaukee/search.json?q=%22renewable+energy%22+OR+%22clean+energy%22+OR+%22green+energy%22+OR+%22energy+efficiency%22+OR+%22wind+energy%22+OR+%22wind+power%22+OR+%22wind+farm%22&restrict_sr=1&sort=new&limit=15&t=year', tag: 'topical', requireBrand: false },
  { url: 'https://www.reddit.com/r/madisonwi+wisconsin+madison+milwaukee/search.json?q=%22electric+bill%22+OR+%22gas+bill%22+OR+%22utility+bill%22+OR+%22rate+increase%22+OR+%22rate+hike%22+OR+%22rate+case%22&restrict_sr=1&sort=new&limit=15&t=year', tag: 'topical', requireBrand: false },
  { url: 'https://www.reddit.com/r/madisonwi+wisconsin+madison+milwaukee/search.json?q=%22heat+pump%22+OR+%22EV+charger%22+OR+%22electric+vehicle%22+OR+%22charging+station%22+OR+%22focus+on+energy%22&restrict_sr=1&sort=new&limit=15&t=year', tag: 'topical', requireBrand: false },
  { url: 'https://www.reddit.com/r/madisonwi+wisconsin+madison+milwaukee/search.json?q=%22battery+storage%22+OR+%22energy+storage%22+OR+%22grid+modernization%22+OR+%22smart+meter%22+OR+%22net+metering%22+OR+%22decarbonization%22+OR+%22electrification%22&restrict_sr=1&sort=new&limit=10&t=year', tag: 'topical', requireBrand: false },
  { url: 'https://www.reddit.com/r/madisonwi+wisconsin+madison+milwaukee/search.json?q=%22solar+installer%22+OR+%22solar+tax+credit%22+OR+%22solar+rebate%22+OR+%22Inflation+Reduction+Act%22+OR+%22clean+energy+jobs%22&restrict_sr=1&sort=new&limit=10&t=year', tag: 'topical', requireBrand: false }
];

async function pollReddit() {
  let totalFetched = 0;
  let totalErrors = 0;
  const found = [];
  for (const q of REDDIT_QUERIES) {
    try {
      const resp = await fetch(q.url, {
        headers: {
          'User-Agent': 'MGE-Social-Command-Center/1.0 (by u/MGEsocial; Madison Gas and Electric brand monitoring)',
          'Accept': 'application/json'
        }
      });
      if (!resp.ok) {
        console.warn(' [MENTIONS] Reddit query ' + resp.status + ': ' + q.url.substring(0, 80));
        totalErrors++;
        continue;
      }
      const data = await resp.json();
      const children = (data && data.data && data.data.children) || [];
      totalFetched += children.length;
      for (const c of children) {
        const d = c.data;
        if (!d || !d.id) continue;
        const text = (d.title || '') + ' ' + (d.selftext || '');
        const permalink = 'https://www.reddit.com' + (d.permalink || '');
        const externalUrl = d.url_overridden_by_dest || '';
        let brandTag = q.tag;
        let matchedKeyword = q.tag;
        let confidence = 'medium';

        // Check external link for excluded domains too (catches stock bots posting to Reddit)
        if (externalUrl && EXCLUDED_DOMAINS.test(externalUrl)) continue;

        if (q.requireBrand) {
          const m = matchesAnyBrand(text, externalUrl || permalink);
          if (!m || m.brand !== q.tag) continue;
          matchedKeyword = m.keyword;
          confidence = m.confidence;
        } else {
          // Topical query — require strict energy signal (not just political/general mentions)
          const m = matchesAnyBrand(text, externalUrl || permalink);
          if (m) {
            // Still accept if it matches a known brand — that's always valid
            brandTag = m.brand;
            matchedKeyword = m.keyword;
            confidence = m.confidence;
          } else {
            // For pure topical, require the text to hit the strict signal list
            // AND have more utility signals than political noise,
            // AND pass the US geography gate (drops non-US content)
            if (!verifyTopicalContent(text)) continue;
            if (!verifyTopicalGeography(text)) continue;
            // Use the first strict-signal match as the displayed keyword
            const sig = text.match(TOPICAL_STRICT_SIGNALS);
            matchedKeyword = sig ? sig[0] : 'energy topic';
            confidence = 'topical';
          }
        }

        // Thumbnail extraction
        let thumb = null;
        if (d.thumbnail && !/^(self|default|nsfw|spoiler|image|)$/.test(d.thumbnail) && /^https?:/.test(d.thumbnail)) {
          thumb = d.thumbnail;
        }
        if (!thumb && d.preview && d.preview.images && d.preview.images[0]) {
          const src = d.preview.images[0].source && d.preview.images[0].source.url;
          if (src) thumb = String(src).replace(/&amp;/g, '&');
        }
        if (!thumb && d.url_overridden_by_dest && /\.(jpe?g|png|gif|webp)(\?|$)/i.test(d.url_overridden_by_dest)) {
          thumb = d.url_overridden_by_dest;
        }

        // External URL: if this is a link post (not self-post), store where it points
        let extUrl = null;
        if (d.url_overridden_by_dest &&
            !d.url_overridden_by_dest.startsWith('https://www.reddit.com') &&
            !d.url_overridden_by_dest.startsWith('https://reddit.com') &&
            !d.url_overridden_by_dest.startsWith('/r/')) {
          extUrl = d.url_overridden_by_dest;
        }
        found.push({
          id: 'reddit:' + d.id,
          source: 'reddit',
          sourceDisplay: 'Reddit \u00b7 r/' + d.subreddit,
          sourceName: 'r/' + d.subreddit,
          title: d.title || '',
          snippet: (d.selftext || '').substring(0, 300),
          url: 'https://www.reddit.com' + d.permalink,
          externalUrl: extUrl,
          author: 'u/' + (d.author || 'unknown'),
          publishedAt: new Date((d.created_utc || Date.now() / 1000) * 1000).toISOString(),
          thumbnail: thumb,
          brandTag: brandTag,
          matchedKeyword: matchedKeyword,
          confidence: confidence,
          engagement: { score: d.score || 0, comments: d.num_comments || 0 }
        });
      }
      // Small delay between Reddit queries so we don't trip rate limits
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.warn(' [MENTIONS] Reddit query error:', err.message);
      totalErrors++;
    }
  }
  console.log(' [MENTIONS] Reddit: ' + REDDIT_QUERIES.length + ' queries, ' + totalFetched + ' posts fetched, ' + found.length + ' matched, ' + totalErrors + ' errors');
  addMentions('reddit', found);
}

// --- 2. Google Alerts RSS (Taylor creates the alerts, we poll URLs from env) ---
function extractGalertUrl(wrapped) {
  if (!wrapped) return null;
  try { return new URL(wrapped).searchParams.get('url') || null; } catch { return null; }
}

async function pollGoogleAlerts() {
  const urls = (process.env.GOOGLE_ALERTS_RSS_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (urls.length === 0) { MENTIONS.lastPoll.google_alerts = new Date().toISOString(); return; }
  const found = [];
  for (const url of urls) {
    try {
      const feed = await rssParser.parseURL(url);
      for (const item of (feed.items || [])) {
        const actualUrl = extractGalertUrl(item.link) || item.link;
        const titleText = cleanHtml(item.title || '');
        const bodyText = cleanHtml(item.contentSnippet || item.content || '');
        const text = titleText + ' ' + bodyText;
        const m = matchesAnyBrand(text, actualUrl, titleText);
        if (!m) continue;
        let domain = 'Google Alerts';
        try { domain = new URL(actualUrl).hostname.replace(/^www\./, ''); } catch {}
        found.push({
          id: 'galerts:' + (item.guid || actualUrl),
          source: 'google_alerts',
          sourceDisplay: 'Google Alerts \u00b7 ' + domain,
          sourceName: domain,
          title: cleanHtml(item.title || ''),
          snippet: cleanHtml(item.contentSnippet || item.content || '').substring(0, 300),
          url: actualUrl,
          author: domain,
          publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
          thumbnail: imageFromRssItem(item),
          brandTag: m.brand,
          matchedKeyword: m.keyword,
          confidence: m.confidence
        });
      }
    } catch (err) {
      console.warn(' [MENTIONS] Google Alert feed failed:', err.message);
    }
  }
  addMentions('google_alerts', found);
}

// --- 3. GDELT Doc 2.0 (free news API) ---
function parseGdeltDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

async function pollGDELT() {
  try {
    const queries = [
      { q: '"Madison Gas and Electric"', tag: 'mge' },
      { q: '"Madison Gas & Electric"', tag: 'mge' },
      { q: '"MG&E" Wisconsin', tag: 'mge' },
      { q: '"Alliant Energy" Wisconsin', tag: 'alliant' },
      { q: '"We Energies"', tag: 'we_energies' }
    ];
    const found = [];
    for (const { q, tag } of queries) {
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&format=json&maxrecords=75&sort=DateDesc&timespan=3months`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const body = await resp.text();
      let data; try { data = JSON.parse(body); } catch { continue; }
      for (const a of (data.articles || [])) {
        const m = matchesAnyBrand(a.title || '', a.url);
        if (!m || m.brand !== tag) continue;
        found.push({
          id: 'gdelt:' + (a.url || a.documentidentifier || a.title),
          source: 'gdelt',
          sourceDisplay: 'GDELT \u00b7 ' + (a.domain || 'news'),
          sourceName: a.domain || 'News',
          title: a.title || '',
          snippet: '',
          url: a.url,
          author: a.domain || 'Unknown',
          publishedAt: parseGdeltDate(a.seendate) || new Date().toISOString(),
          thumbnail: a.socialimage || null,
          brandTag: m.brand,
          matchedKeyword: m.keyword,
          confidence: m.confidence
        });
      }
    }
    console.log(' [MENTIONS] GDELT: ' + found.length + ' matched across ' + queries.length + ' queries (3-month window)');
    addMentions('gdelt', found);
  } catch (err) {
    console.warn(' [MENTIONS] GDELT failed:', err.message);
  }
}

// --- 4. YouTube keyword search (reuses existing YOUTUBE_API_KEY) ---
async function pollYouTubeMentions() {
  const apiKey = (typeof config !== 'undefined' && config.youtube && config.youtube.apiKey) || process.env.YOUTUBE_API_KEY;
  if (!apiKey) { MENTIONS.lastPoll.youtube_search = new Date().toISOString(); return; }
  try {
    // Limit to last 90 days for YouTube search so we get the 3-month window
    const publishedAfter = new Date(Date.now() - 90 * 86400000).toISOString();
    const queries = [
      { q: '"Madison Gas and Electric"', tag: 'mge' },
      { q: '"MG&E" Wisconsin', tag: 'mge' },
      { q: '"Alliant Energy" Wisconsin', tag: 'alliant' },
      { q: '"We Energies"', tag: 'we_energies' }
    ];
    const found = [];
    for (const { q, tag } of queries) {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&order=date&maxResults=20&publishedAfter=${encodeURIComponent(publishedAfter)}&key=${apiKey}`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const v of (data.items || [])) {
        const s = v.snippet || {};
        const vurl = 'https://www.youtube.com/watch?v=' + (v.id && v.id.videoId);
        const m = matchesAnyBrand((s.title || '') + ' ' + (s.description || ''), vurl);
        if (!m || m.brand !== tag) continue;
        const thumbs = s.thumbnails || {};
        const thumb = (thumbs.high && thumbs.high.url) || (thumbs.medium && thumbs.medium.url) || (thumbs.default && thumbs.default.url) || null;
        found.push({
          id: 'youtube:' + (v.id && v.id.videoId),
          source: 'youtube_search',
          sourceDisplay: 'YouTube \u00b7 ' + (s.channelTitle || 'Search'),
          sourceName: s.channelTitle || 'YouTube',
          title: s.title || '',
          snippet: (s.description || '').substring(0, 300),
          url: 'https://www.youtube.com/watch?v=' + (v.id && v.id.videoId),
          author: s.channelTitle || 'YouTube',
          publishedAt: s.publishedAt || new Date().toISOString(),
          thumbnail: thumb,
          brandTag: m.brand,
          matchedKeyword: m.keyword,
          confidence: m.confidence
        });
      }
    }
    addMentions('youtube_search', found);
  } catch (err) {
    console.warn(' [MENTIONS] YouTube search failed:', err.message);
  }
}

// --- 5. Local news RSS (Wisconsin outlets — TV, print, radio, college) ---
// Audited 2026-04-23. Many direct RSS feeds were failing: TownNews/Cloudflare
// sites block automated requests (429) and several outlets removed or moved
// their public RSS (404). For those, we fall back to Google News "site:" RSS
// searches — Google already indexes these outlets, the feed shape matches
// everything else we parse, and it bypasses Cloudflare entirely.
//
// Helper: build a Google News RSS URL scoped to a single outlet's domain.
// Optional extraTerms scopes to energy-relevant content to cut general noise.
function gNewsSiteFeed(domain, extraTerms) {
  var q = 'site:' + domain;
  if (extraTerms) q += ' (' + extraTerms + ')';
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en';
}
// Energy-relevant query we apply to outlet-site searches so we don't ingest
// every article from a general-interest paper (keeps the Topical feed focused).
var LOCAL_ENERGY_TERMS =
  'solar OR wind OR "wind farm" OR "solar farm" OR energy OR electric OR utility OR ' +
  '"heat pump" OR "electric vehicle" OR "EV charging" OR renewable OR "power outage" OR ' +
  '"rate case" OR grid OR "battery storage" OR MGE OR Alliant OR "We Energies"';

const LOCAL_NEWS_FEEDS = [
  // ========== Madison TV ==========
  { url: gNewsSiteFeed('channel3000.com', LOCAL_ENERGY_TERMS), name: 'Channel 3000 / WISC-TV (via Google News)' }, // direct 404
  { url: gNewsSiteFeed('wkow.com', LOCAL_ENERGY_TERMS), name: 'WKOW 27 (via Google News)' },            // direct 429 (Cloudflare)
  { url: gNewsSiteFeed('nbc15.com', LOCAL_ENERGY_TERMS), name: 'NBC 15 / WMTV (via Google News)' },    // direct 404
  // Madison's FOX affiliate (WMSN) doesn't publish a public RSS. Use Google News site-search.
  { url: gNewsSiteFeed('fox47.com', LOCAL_ENERGY_TERMS), name: 'FOX 47 Madison (via Google News)' },

  // ========== Madison print / magazine ==========
  { url: 'https://madison.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc', name: 'Wisconsin State Journal' },
  { url: gNewsSiteFeed('captimes.com', LOCAL_ENERGY_TERMS), name: 'Cap Times (via Google News)' },     // direct 429 (Cloudflare)
  { url: gNewsSiteFeed('isthmus.com', LOCAL_ENERGY_TERMS), name: 'Isthmus (via Google News)' },         // direct 404
  { url: 'https://badgerherald.com/feed/', name: 'The Badger Herald (UW-Madison)' },
  { url: gNewsSiteFeed('dailycardinal.com', LOCAL_ENERGY_TERMS), name: 'Daily Cardinal (via Google News)' }, // direct 404

  // ========== Milwaukee ==========
  { url: gNewsSiteFeed('jsonline.com', LOCAL_ENERGY_TERMS), name: 'Milwaukee Journal Sentinel (via Google News)' }, // direct 404 (USA Today migration)
  { url: 'https://urbanmilwaukee.com/feed/', name: 'Urban Milwaukee' },
  { url: gNewsSiteFeed('tmj4.com', LOCAL_ENERGY_TERMS), name: 'TMJ4 Milwaukee (via Google News)' },     // direct 404
  { url: 'https://www.cbs58.com/rss', name: 'CBS 58 Milwaukee' },
  { url: gNewsSiteFeed('fox6now.com', LOCAL_ENERGY_TERMS), name: 'FOX6 Milwaukee (via Google News)' }, // direct 404
  { url: 'https://www.wisn.com/topstories-rss', name: 'WISN 12 Milwaukee' },

  // ========== Green Bay / Fox Valley ==========
  { url: gNewsSiteFeed('wbay.com', LOCAL_ENERGY_TERMS), name: 'WBAY Green Bay (via Google News)' },    // direct 404
  { url: gNewsSiteFeed('nbc26.com', LOCAL_ENERGY_TERMS), name: 'NBC 26 Green Bay (via Google News)' }, // direct 404
  { url: gNewsSiteFeed('wearegreenbay.com', LOCAL_ENERGY_TERMS), name: 'WFRV 5 Green Bay (via Google News)' }, // wfrv.com ENOTFOUND; station now on wearegreenbay.com

  // ========== Statewide / public media / advocacy ==========
  { url: 'https://wisconsinexaminer.com/feed/', name: 'Wisconsin Examiner' },
  { url: gNewsSiteFeed('wpr.org', LOCAL_ENERGY_TERMS), name: 'Wisconsin Public Radio (via Google News)' }, // direct 404
  { url: gNewsSiteFeed('wuwm.com', LOCAL_ENERGY_TERMS), name: 'WUWM 89.7 Milwaukee NPR (via Google News)' }, // direct 404
  { url: 'https://wisbusiness.com/feed/', name: 'WisBusiness' },
  { url: 'https://www.biztimes.com/feed/', name: 'BizTimes Milwaukee' }
];

async function pollLocalNews() {
  const found = [];
  const feedStats = [];
  for (const feed of LOCAL_NEWS_FEEDS) {
    let feedStatus = 'ok';
    let itemsInFeed = 0;
    let brandMatched = 0;
    let topicalMatched = 0;
    try {
      // Use resilient fetcher with browser-like UA + 429 retry.
      // Many TownNews/Cloudflare outlets block the default rss-parser UA.
      const data = await parseFeedResilient(feed.url);
      itemsInFeed = (data.items || []).length;
      for (const item of (data.items || [])) {
        const titleText = cleanHtml(item.title || '');
        const bodyText = cleanHtml(item.contentSnippet || item.content || '');
        const text = titleText + ' ' + bodyText;

        let brandTag, matchedKeyword, confidence;
        const m = matchesAnyBrand(text, item.link, titleText);
        if (m) {
          brandTag = m.brand;
          matchedKeyword = m.keyword;
          confidence = m.confidence;
          brandMatched++;
        } else if (verifyTopicalContent(text)) {
          // No brand name matched (often because the RSS body is truncated and
          // brand mentions are deeper in the article), but the headline/snippet
          // hits a utility/energy topical signal. These feeds are already
          // curated to Wisconsin local outlets, so we skip the US geo gate —
          // everything here is US-relevant by definition.
          brandTag = 'topical';
          const sig = text.match(TOPICAL_STRICT_SIGNALS);
          matchedKeyword = sig ? sig[0] : 'industry topic';
          confidence = 'topical';
          topicalMatched++;
        } else {
          continue;
        }

        found.push({
          id: 'news:' + (item.guid || item.link),
          source: 'local_news',
          sourceDisplay: feed.name,
          sourceName: feed.name,
          title: cleanHtml(item.title || ''),
          snippet: cleanHtml(item.contentSnippet || '').substring(0, 300),
          url: item.link,
          author: item.creator || feed.name,
          publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
          thumbnail: imageFromRssItem(item),
          brandTag: brandTag,
          matchedKeyword: matchedKeyword,
          confidence: confidence
        });
      }
    } catch (err) {
      feedStatus = 'ERROR:' + (err.code || err.message || 'unknown').substring(0, 40);
    }
    feedStats.push(feed.name + ' [' + feedStatus + '] items=' + itemsInFeed + ' brand=' + brandMatched + ' topical=' + topicalMatched);
  }
  console.log(' [MENTIONS] Local News: ' + LOCAL_NEWS_FEEDS.length + ' feeds, ' + found.length + ' total matches');
  for (const s of feedStats) console.log('   \u2514 ' + s);
  addMentions('local_news', found);
}

// --- 6. Google News RSS (aggregator — broadest single source, covers thousands of outlets) ---
const GOOGLE_NEWS_QUERIES = [
  // Brand mentions
  { q: '"Madison Gas and Electric"', tag: 'mge' },
  { q: '"MG&E" Wisconsin utility', tag: 'mge' },
  { q: '"MGE Energy" Wisconsin', tag: 'mge' },
  // PSC (Wisconsin Public Service Commission) site-scoped — regulatory filings, press releases
  { q: 'site:psc.wi.gov "Madison Gas and Electric"', tag: 'mge' },
  { q: 'site:psc.wi.gov MGE rate', tag: 'mge' },
  { q: '"Madison Gas and Electric" rate case', tag: 'mge' },
  { q: '"Madison Gas and Electric" PSC docket', tag: 'mge' },
  // Competitors
  { q: '"Alliant Energy" Wisconsin', tag: 'alliant' },
  { q: '"We Energies"', tag: 'we_energies' },
  // Topical — Wisconsin energy/utility/renewable industry
  { q: 'Wisconsin utility rate case', tag: 'topical' },
  { q: 'Wisconsin Public Service Commission ruling', tag: 'topical' },
  { q: 'Wisconsin renewable energy', tag: 'topical' },
  { q: 'Wisconsin solar energy', tag: 'topical' },
  { q: 'Madison solar energy', tag: 'topical' },
  { q: 'Wisconsin solar panels', tag: 'topical' },
  { q: 'Wisconsin community solar', tag: 'topical' },
  { q: 'Wisconsin wind energy', tag: 'topical' },
  { q: 'Wisconsin EV charging', tag: 'topical' },
  { q: 'Wisconsin electric vehicle', tag: 'topical' },
  { q: 'Wisconsin battery storage', tag: 'topical' },
  { q: 'Wisconsin grid modernization', tag: 'topical' },
  { q: 'Wisconsin heat pump', tag: 'topical' },
  { q: 'Midwest utility renewable', tag: 'topical' },
  { q: 'Midwest solar energy', tag: 'topical' },
  { q: '"Focus on Energy" Wisconsin', tag: 'topical' }
];

function gNewsRssUrl(q) {
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en';
}

async function pollGoogleNews() {
  const found = [];
  for (const { q, tag } of GOOGLE_NEWS_QUERIES) {
    try {
      const feed = await rssParser.parseURL(gNewsRssUrl(q));
      for (const item of (feed.items || [])) {
        const titleText = cleanHtml(item.title || '');
        const bodyText = cleanHtml(item.contentSnippet || item.content || '');
        const text = titleText + ' ' + bodyText;
        const m = matchesAnyBrand(text, item.link, titleText);
        if (!m) continue;
        // For topical queries, still require the strict energy signal so we don't drown in noise
        if (tag === 'topical' && m.brand === 'mge') {
          // brand matched — fine, keep
        } else if (tag === 'topical') {
          if (!verifyTopicalContent(text)) continue;
          if (!verifyTopicalGeography(text)) continue;
        }
        // Google News source is usually embedded in the title as "Headline - Source Name"
        let srcName = 'Google News';
        const src = item.source && (typeof item.source === 'string' ? item.source : (item.source._ || item.source.name));
        if (src) srcName = String(src);
        else {
          // Fallback: extract from title trailing " - Source"
          const match = (item.title || '').match(/\s-\s([^-]+)$/);
          if (match) srcName = match[1].trim();
        }
        found.push({
          id: 'gnews:' + (item.guid || item.link),
          source: 'google_news',
          sourceDisplay: 'Google News \u00b7 ' + srcName,
          sourceName: srcName,
          title: cleanHtml(item.title || '').replace(/\s-\s[^-]+$/, ''), // strip trailing " - Source"
          snippet: cleanHtml(item.contentSnippet || '').substring(0, 300),
          url: item.link,
          author: srcName,
          publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
          thumbnail: imageFromRssItem(item),
          brandTag: m.brand,
          matchedKeyword: m.keyword,
          confidence: m.confidence
        });
      }
    } catch (err) {
      console.warn(' [MENTIONS] Google News query failed (' + q + '):', err.message);
    }
  }
  console.log(' [MENTIONS] Google News: ' + GOOGLE_NEWS_QUERIES.length + ' queries, ' + found.length + ' matches');
  addMentions('google_news', found);
}

// --- 7. Industry trade publications (energy/utility vertical press) ---
const INDUSTRY_FEEDS = [
  { url: 'https://www.utilitydive.com/feeds/news/', name: 'Utility Dive' },
  { url: 'https://www.canarymedia.com/rss/feed', name: 'Canary Media' },
  { url: 'https://energynews.us/feed/', name: 'Energy News Network' },
  { url: 'https://www.renewableenergyworld.com/feed/', name: 'Renewable Energy World' },
  { url: 'https://www.tdworld.com/rss.xml', name: 'T&D World' },
  { url: 'https://www.powermag.com/feed/', name: 'POWER Magazine' }
];

async function pollIndustryNews() {
  const found = [];
  let brandHits = 0, topicalHits = 0;
  for (const feed of INDUSTRY_FEEDS) {
    try {
      const data = await rssParser.parseURL(feed.url);
      for (const item of (data.items || [])) {
        const titleText = cleanHtml(item.title || '');
        const bodyText = cleanHtml(item.contentSnippet || item.content || '');
        const text = titleText + ' ' + bodyText;
        let brandTag, matchedKeyword, confidence;
        // First try brand match (MGE, Alliant, We Energies) — title-aware to kill footer links
        const m = matchesAnyBrand(text, item.link, titleText);
        if (m) {
          brandTag = m.brand;
          matchedKeyword = m.keyword;
          confidence = m.confidence;
          brandHits++;
        } else if (TOPICAL_STRICT_SIGNALS.test(text)) {
          // Industry pubs already pre-filter to utility topics, so accept any strict-signal match
          // (renewables, solar, grid, EVs, decarb) without brand-name requirement.
          // Gate to US content so we don't surface Ukraine wind farms, EU energy policy, etc.
          if (!verifyTopicalGeography(text)) continue;
          brandTag = 'topical';
          const sig = text.match(TOPICAL_STRICT_SIGNALS);
          matchedKeyword = sig ? sig[0] : 'industry trend';
          confidence = 'topical';
          topicalHits++;
        } else {
          continue;
        }
        found.push({
          id: 'industry:' + (item.guid || item.link),
          source: 'industry_news',
          sourceDisplay: feed.name,
          sourceName: feed.name,
          title: cleanHtml(item.title || ''),
          snippet: cleanHtml(item.contentSnippet || '').substring(0, 300),
          url: item.link,
          author: item.creator || feed.name,
          publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
          thumbnail: imageFromRssItem(item),
          brandTag: brandTag,
          matchedKeyword: matchedKeyword,
          confidence: confidence
        });
      }
    } catch (err) {
      console.warn(' [MENTIONS] Industry feed failed: ' + feed.name + ' (' + err.message + ')');
    }
  }
  console.log(' [MENTIONS] Industry News: ' + INDUSTRY_FEEDS.length + ' feeds, ' + found.length + ' matches (' + brandHits + ' brand, ' + topicalHits + ' topical)');
  addMentions('industry_news', found);
}

// --- 8. SEC EDGAR filings (MGE Energy holding co + Madison Gas and Electric subsidiary) ---
// Uses SEC's modern data.sec.gov JSON API (the legacy browse-edgar CGI endpoint returns
// empty HTML for many CIKs even with output=atom). Public, no auth, but requires a
// descriptive User-Agent with contact info per SEC's fair-use policy.
const SEC_COMPANIES = [
  { cik: '0001161728', name: 'MGE Energy, Inc.', ticker: 'MGEE' }, // holding company (publicly traded)
  { cik: '0000061339', name: 'Madison Gas and Electric Company', ticker: null } // operating utility subsidiary
];

// Human-readable labels for common SEC form types. Used as fallback when
// data.sec.gov returns the form type itself as primaryDocDescription
// (which yielded titles like "8-K — 8-K"). Expand as needed.
const SEC_FORM_LABELS = {
  '3':        'Initial Statement of Beneficial Ownership',
  '4':        'Changes in Beneficial Ownership',
  '5':        'Annual Statement of Beneficial Ownership',
  '8-K':      'Current Report (material event)',
  '8-K/A':    'Current Report Amendment',
  '10-K':     'Annual Report',
  '10-K/A':   'Annual Report Amendment',
  '10-Q':     'Quarterly Report',
  '10-Q/A':   'Quarterly Report Amendment',
  '11-K':     'Employee Benefit Plan Annual Report',
  'DEF 14A':  'Definitive Proxy Statement',
  'DEF14A':   'Definitive Proxy Statement',
  'DEFA14A':  'Additional Proxy Materials',
  'PRE 14A':  'Preliminary Proxy Statement',
  'ARS':      'Annual Report to Shareholders',
  'S-1':      'Registration Statement',
  'S-3':      'Shelf Registration',
  'S-3/A':    'Shelf Registration Amendment',
  'S-8':      'Employee Benefit Plan Registration',
  '424B2':    'Prospectus Supplement',
  '424B3':    'Prospectus Supplement',
  '424B5':    'Prospectus Supplement',
  'FWP':      'Free Writing Prospectus',
  'SC 13G':   'Beneficial Ownership Report',
  'SC 13G/A': 'Beneficial Ownership Report Amendment',
  'SC 13D':   'Acquisition of Beneficial Ownership',
  'SD':       'Specialized Disclosure Report',
  'NT 10-K':  'Notification of Late 10-K Filing',
  'NT 10-Q':  'Notification of Late 10-Q Filing'
};

function secSubmissionsUrl(cik) {
  // CIK must be zero-padded to 10 digits for data.sec.gov
  const padded = String(cik).padStart(10, '0');
  return 'https://data.sec.gov/submissions/CIK' + padded + '.json';
}

function secFilingUrl(cik, accessionNumber, primaryDocument) {
  // Build a clean HTTPS link to the filing index page on sec.gov
  const accNoDashes = String(accessionNumber).replace(/-/g, '');
  const cikNum = parseInt(cik, 10);
  return 'https://www.sec.gov/Archives/edgar/data/' + cikNum + '/' + accNoDashes + '/' + (primaryDocument || (accessionNumber + '-index.htm'));
}

// SEC requires a descriptive User-Agent with contact info per their fair-use policy
// (https://www.sec.gov/developer). Generic UAs get blocked.
const SEC_USER_AGENT = 'MGE Social Command Center tgraham@mge.com';

async function pollSECFilings() {
  const found = [];
  for (const company of SEC_COMPANIES) {
    try {
      const resp = await fetch(secSubmissionsUrl(company.cik), {
        headers: {
          'User-Agent': SEC_USER_AGENT,
          'Accept': 'application/json'
        }
      });
      if (!resp.ok) {
        console.warn(' [MENTIONS] SEC ' + resp.status + ' for ' + company.name + ' (' + company.cik + ')');
        continue;
      }
      const data = await resp.json();
      const recent = (data.filings && data.filings.recent) || {};
      const accs = recent.accessionNumber || [];
      const forms = recent.form || [];
      const dates = recent.filingDate || [];
      const primaryDocs = recent.primaryDocument || [];
      const primaryDescs = recent.primaryDocDescription || [];
      const entityName = data.name || company.name;
      // Take the 40 most recent filings per company
      const count = Math.min(accs.length, 40);
      for (let i = 0; i < count; i++) {
        const acc = accs[i];
        const formType = forms[i] || 'Filing';
        const filingDate = dates[i];
        const primaryDoc = primaryDocs[i];
        const desc = primaryDescs[i] || '';
        // SEC's API often returns the form type again as primaryDocDescription,
        // which yielded titles like "8-K — 8-K". Fall back to a human-readable
        // form-type map when desc is empty OR equals the form type.
        const humanForm = SEC_FORM_LABELS[formType] || null;
        let humanDesc = '';
        if (desc && desc.trim().toLowerCase() !== formType.toLowerCase()) {
          humanDesc = desc;
        } else if (humanForm) {
          humanDesc = humanForm;
        }
        const titleText = entityName + ' filed ' + formType + (humanDesc ? ' — ' + humanDesc : '');
        found.push({
          id: 'sec:' + company.cik + ':' + acc,
          source: 'sec_filings',
          sourceDisplay: 'SEC EDGAR \u00b7 ' + entityName,
          sourceName: entityName + (company.ticker ? ' (' + company.ticker + ')' : ''),
          title: titleText,
          snippet: 'Filed with the U.S. Securities and Exchange Commission by ' + entityName + '. Form type: ' + formType + (humanDesc ? ' (' + humanDesc + ')' : '') + '.',
          url: secFilingUrl(company.cik, acc, primaryDoc),
          author: entityName,
          publishedAt: filingDate ? new Date(filingDate + 'T16:00:00Z').toISOString() : new Date().toISOString(),
          thumbnail: null,
          brandTag: 'mge',
          matchedKeyword: formType,
          confidence: 'high'
        });
      }
    } catch (err) {
      console.warn(' [MENTIONS] SEC EDGAR failed for ' + company.name + ':', err.message);
    }
  }
  console.log(' [MENTIONS] SEC Filings: ' + SEC_COMPANIES.length + ' companies, ' + found.length + ' filings');
  addMentions('sec_filings', found);
}

// --- 9. Apple Podcasts (iTunes Search API — free, no auth) ---
const PODCAST_QUERIES = [
  'Madison Gas and Electric',
  'MGE Energy Wisconsin',
  'Wisconsin utility',
  'Wisconsin energy'
];

async function pollPodcasts() {
  const found = [];
  for (const q of PODCAST_QUERIES) {
    try {
      const url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(q) + '&media=podcast&entity=podcast&limit=15';
      const resp = await fetch(url, { headers: { 'User-Agent': 'MGE-Social-Command-Center/1.0' } });
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const p of (data.results || [])) {
        const title = p.collectionName || p.trackName || '';
        const description = p.description || p.shortDescription || '';
        const text = title + ' ' + description;
        const m = matchesAnyBrand(text, p.collectionViewUrl || p.trackViewUrl);
        if (!m) continue;
        found.push({
          id: 'podcast:' + (p.collectionId || p.trackId || title),
          source: 'podcasts',
          sourceDisplay: 'Apple Podcasts \u00b7 ' + (p.artistName || 'Unknown'),
          sourceName: p.artistName || 'Apple Podcasts',
          title: title,
          snippet: description.substring(0, 300),
          url: p.collectionViewUrl || p.trackViewUrl,
          author: p.artistName || 'Unknown',
          publishedAt: p.releaseDate || new Date().toISOString(),
          thumbnail: p.artworkUrl600 || p.artworkUrl100 || null,
          brandTag: m.brand,
          matchedKeyword: m.keyword,
          confidence: m.confidence
        });
      }
    } catch (err) {
      console.warn(' [MENTIONS] Podcasts query failed (' + q + '):', err.message);
    }
  }
  console.log(' [MENTIONS] Podcasts: ' + PODCAST_QUERIES.length + ' queries, ' + found.length + ' matches');
  addMentions('podcasts', found);
}

// --- 10. Facebook visitor posts (people posting on MGE's Page wall) ---
// Uses /visitor_posts endpoint which needs pages_read_user_content (already granted,
// since we're reading user-generated comments elsewhere). /tagged endpoint was dropped
// because it requires "Page Public Content Access" app-level feature via Meta App Review.
async function pollFacebookVisitorPosts() {
  const token = process.env.FACEBOOK_PAGE_TOKEN || (typeof config !== 'undefined' && config.facebook && config.facebook.pageAccessToken) || '';
  const pageId = process.env.FACEBOOK_PAGE_ID || (typeof config !== 'undefined' && config.facebook && config.facebook.pageId) || '';
  if (!token || !pageId) {
    MENTIONS.lastPoll.facebook_visitor = new Date().toISOString();
    return;
  }
  try {
    const url = `${META_BASE}/${pageId}/visitor_posts?fields=id,message,story,created_time,from{id,name,picture},permalink_url,full_picture,type&limit=50&access_token=${token}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const body = await resp.text();
      console.warn(' [MENTIONS] Facebook visitor posts ' + resp.status + ':', body.substring(0, 300));
      MENTIONS.lastPoll.facebook_visitor = new Date().toISOString();
      return;
    }
    const data = await resp.json();
    const posts = data.data || [];
    const found = posts
      .filter(p => {
        // Safety net: drop MGE's own posts if the endpoint ever returns them
        const fromId = p.from && p.from.id;
        return !fromId || fromId !== pageId;
      })
      .map(p => {
        const msg = (p.message || p.story || 'Facebook post').trim();
        const fromName = (p.from && p.from.name) || 'Facebook User';
        return {
          id: 'fbvisit:' + p.id,
          source: 'facebook_visitor',
          sourceDisplay: 'Facebook Wall \u00b7 ' + fromName,
          sourceName: fromName,
          title: msg.length > 90 ? msg.substring(0, 87) + '...' : msg,
          snippet: msg.substring(0, 300),
          url: p.permalink_url || ('https://www.facebook.com/' + p.id),
          author: fromName,
          publishedAt: p.created_time || new Date().toISOString(),
          thumbnail: p.full_picture || null,
          brandTag: 'mge',
          matchedKeyword: 'Posted on MGE wall',
          confidence: 'high'
        };
      });
    console.log(' [MENTIONS] Facebook visitor posts: ' + found.length + ' wall posts');
    addMentions('facebook_visitor', found);
  } catch (err) {
    console.warn(' [MENTIONS] Facebook visitor posts error:', err.message);
    MENTIONS.lastPoll.facebook_visitor = new Date().toISOString();
  }
}

// --- 11. Instagram tagged posts (DISABLED — endpoint requires instagram_manage_insights
// which needs Meta App Review. Function kept for easy re-enable later.) ---
async function pollInstagramTagged() {
  const token = process.env.INSTAGRAM_TOKEN || process.env.FACEBOOK_PAGE_TOKEN || (typeof config !== 'undefined' && config.instagram && config.instagram.accessToken) || '';
  const userId = process.env.INSTAGRAM_USER_ID || (typeof config !== 'undefined' && config.instagram && config.instagram.igUserId) || '';
  if (!token || !userId) {
    MENTIONS.lastPoll.instagram_tagged = new Date().toISOString();
    return;
  }
  try {
    const url = `${META_BASE}/${userId}/tags?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,username,like_count,comments_count&limit=50&access_token=${token}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      const body = await resp.text();
      console.warn(' [MENTIONS] Instagram tagged ' + resp.status + ':', body.substring(0, 300));
      MENTIONS.lastPoll.instagram_tagged = new Date().toISOString();
      return;
    }
    const data = await resp.json();
    const found = (data.data || []).map(m => {
      const cap = (m.caption || 'Instagram post').trim();
      const user = m.username || 'user';
      return {
        id: 'igtag:' + m.id,
        source: 'instagram_tagged',
        sourceDisplay: 'Instagram \u00b7 @' + user,
        sourceName: '@' + user,
        title: cap.length > 90 ? cap.substring(0, 87) + '...' : cap,
        snippet: cap.substring(0, 300),
        url: m.permalink,
        author: '@' + user,
        publishedAt: m.timestamp || new Date().toISOString(),
        thumbnail: m.media_url || m.thumbnail_url || null,
        brandTag: 'mge',
        matchedKeyword: '@MGE tag',
        confidence: 'high',
        engagement: (m.like_count || m.comments_count) ? { score: m.like_count || 0, comments: m.comments_count || 0 } : null
      };
    });
    console.log(' [MENTIONS] Instagram tagged: ' + found.length + ' tagged posts');
    addMentions('instagram_tagged', found);
  } catch (err) {
    console.warn(' [MENTIONS] Instagram tagged error:', err.message);
    MENTIONS.lastPoll.instagram_tagged = new Date().toISOString();
  }
}

// --- Staggered schedulers (spread API calls, stay well under rate limits) ---
function startMentionPollers() {
  console.log(' [MENTIONS] Starting pollers (9 sources, staggered)...');
  setTimeout(pollReddit, 5000);
  setTimeout(pollLocalNews, 20000);
  setTimeout(pollGoogleNews, 40000);
  setTimeout(pollGoogleAlerts, 60000);
  setTimeout(pollGDELT, 80000);
  setTimeout(pollSECFilings, 95000);
  setTimeout(pollIndustryNews, 115000);
  setTimeout(pollPodcasts, 140000);
  setTimeout(pollYouTubeMentions, 165000);
  setInterval(pollReddit, 30 * 60 * 1000);
  setInterval(pollLocalNews, 30 * 60 * 1000);
  setInterval(pollGoogleNews, 45 * 60 * 1000);
  setInterval(pollGoogleAlerts, 60 * 60 * 1000);
  setInterval(pollGDELT, 120 * 60 * 1000);
  setInterval(pollSECFilings, 360 * 60 * 1000); // SEC filings slow, every 6h
  setInterval(pollIndustryNews, 180 * 60 * 1000);
  setInterval(pollPodcasts, 720 * 60 * 1000); // Podcasts slow, every 12h
  setInterval(pollYouTubeMentions, 240 * 60 * 1000);
  // Facebook visitor_posts and Instagram tags both deprecated/restricted for New Pages
  // Experience accounts. Meta-side platform decision, no workaround without webhook App Review.
}

// --- API endpoints ---
app.get('/api/mentions', (req, res) => {
  const { source, keyword, since, until, brand } = req.query;
  let items = MENTIONS.items.slice();
  if (source && source !== 'all') items = items.filter(m => m.source === source);
  if (brand && brand !== 'all') {
    const brandList = String(brand).split(',').map(s => s.trim()).filter(Boolean);
    if (brandList.length > 0) items = items.filter(m => brandList.includes(m.brandTag || 'mge'));
  }
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    items = items.filter(m => (m.title || '').toLowerCase().includes(kw) || (m.snippet || '').toLowerCase().includes(kw));
  }
  if (since) {
    const sd = new Date(since);
    if (!isNaN(sd.getTime())) items = items.filter(m => new Date(m.publishedAt) >= sd);
  }
  if (until) {
    const ud = new Date(until);
    if (!isNaN(ud.getTime())) items = items.filter(m => new Date(m.publishedAt) <= ud);
  }
  res.json({
    count: items.length,
    total: MENTIONS.items.length,
    lastPoll: MENTIONS.lastPoll,
    stats: MENTIONS.stats,
    brandStats: MENTIONS.brandStats,
    items
  });
});

// Diagnostic endpoint — tests each low-yield source and reports the raw API response.
// Use when FB/IG/SEC/Podcasts show 0 counts to see WHY (permissions? bad token? truly empty?).
app.get('/api/mentions/diagnose', async (req, res) => {
  const results = {};

  // Facebook mentions are unavailable via API for New Pages Experience accounts
  // (both /tagged and /visitor_posts return "Unavailable Feature On New Page Experience").
  results.facebook = { note: 'Not available — MGE Page is on New Pages Experience; /tagged and /visitor_posts are deprecated by Meta for NPE accounts.' };

  // SEC EDGAR (MGE Energy) — uses data.sec.gov JSON API now, not the old atom feed
  try {
    const url = secSubmissionsUrl('0001161728'); // MGE Energy, Inc.
    const r = await fetch(url, {
      headers: { 'User-Agent': SEC_USER_AGENT, 'Accept': 'application/json' }
    });
    const body = await r.text();
    results.sec_filings = {
      status: r.status,
      ok: r.ok,
      bodyLen: body.length,
      preview: body.substring(0, 500)
    };
  } catch (e) { results.sec_filings = { error: e.message }; }

  // Apple Podcasts
  try {
    const r = await fetch('https://itunes.apple.com/search?term=Madison+Gas+and+Electric&media=podcast&entity=podcast&limit=3');
    const data = await r.json();
    results.podcasts = {
      status: r.status,
      resultCount: data.resultCount,
      titles: (data.results || []).map(p => (p.collectionName || p.trackName || '').substring(0, 60))
    };
  } catch (e) { results.podcasts = { error: e.message }; }

  res.json(results);
});

let _lastManualMentionsRefresh = 0;
app.post('/api/mentions/refresh', (req, res) => {
  const now = Date.now();
  if (now - _lastManualMentionsRefresh < 60000) {
    return res.json({ error: true, message: 'Please wait at least 60 seconds between manual refreshes.' });
  }
  _lastManualMentionsRefresh = now;
  Promise.all([
    pollReddit(),
    pollLocalNews(),
    pollGoogleNews(),
    pollGoogleAlerts(),
    pollGDELT(),
    pollSECFilings(),
    pollIndustryNews(),
    pollPodcasts(),
    pollYouTubeMentions()
  ]).catch(() => {});
  res.json({ ok: true, message: 'Refresh triggered across all 9 sources. New mentions will appear within ~60 seconds.' });
});

if (process.env.NODE_ENV === 'production' || process.env.ENABLE_MENTIONS === 'true') {
  startMentionPollers();
}

// ============================================================
// END MEDIA MONITORING & MENTIONS
// ============================================================


// ============================================================
// AI INSIGHTS — narrative summary of the selected window
// POST /api/insights with { metrics, prior, topPosts, commentSample }
// Returns { whatHappened, whatsWorking, whatToTry }
//
// Dual-provider: auto-detects which API key is configured in env vars.
//   - ANTHROPIC_API_KEY  → calls Claude (preferred if both set)
//   - GEMINI_API_KEY     → calls Google Gemini (free tier friendly)
//   - neither → returns 503 and the UI shows a friendly "configure a key" placeholder
// ============================================================
const CLAUDE_MODEL_DEFAULT = 'claude-sonnet-4-6';
const GEMINI_MODEL_DEFAULT = 'gemini-2.0-flash';
const INSIGHTS_SYSTEM_PROMPT =
  'You are a senior digital marketing strategist at Madison Gas and Electric (MGE), a Wisconsin utility. ' +
  'You review social media performance data and produce editorial-quality insights for the marketing team. ' +
  'Hard rules: (1) Every claim must cite a specific post, metric, or platform from the data — never generic. ' +
  '(2) Never invent numbers. If something is unknown, say "not reported in this window" rather than guessing. ' +
  '(3) If the sample is small (e.g., 1-2 posts per platform) or a metric is missing/zero (reach, impressions), ' +
  'flag that limitation explicitly instead of drawing broad conclusions. ' +
  '(4) Write in a warm, plain, professional tone. No hype, no emojis, no marketing buzzwords. ' +
  '(5) Be surgical with specificity: name posts by their subject ("the Falcon Cam YouTube post"), ' +
  'not vague categories ("video content"). ' +
  '(6) Recommendations must be things a marketer can actually do next week, not strategic platitudes.';

function buildInsightsUserPrompt(body) {
  const m = body.metrics || {};
  const prior = body.prior;
  const posts = (body.topPosts || []).slice(0, 20);
  const comments = (body.commentSample || []).slice(0, 40);

  const lines = [];
  lines.push('Window: ' + (m.dateRange || 'unspecified'));
  lines.push('Totals: ' + m.postCount + ' posts, ' + m.commentCount + ' comments, ' +
             (m.totalEngagement || 0) + ' engagement, ' + (m.totalReach || 0) + ' reach.');
  if (prior) {
    const engDelta = (m.totalEngagement || 0) - (prior.totalEngagement || 0);
    const engPct = prior.totalEngagement ? Math.round((engDelta / prior.totalEngagement) * 100) : null;
    lines.push('Prior period: ' + prior.postCount + ' posts, ' + (prior.totalEngagement || 0) +
               ' engagement' + (engPct != null ? ' (' + (engDelta >= 0 ? '+' : '') + engPct + '% vs prior)' : '') + '.');
  }
  if (m.platforms) {
    const parts = [];
    Object.keys(m.platforms).forEach(function(k) {
      parts.push(k + ': ' + m.platforms[k].posts + ' posts / ' + m.platforms[k].engagement + ' eng');
    });
    if (parts.length) lines.push('By platform: ' + parts.join(' | '));
  }
  lines.push('');
  lines.push('Top-engaging posts (up to 20, sorted by engagement):');
  posts.forEach(function(p, i) {
    lines.push(
      (i + 1) + '. [' + (p.platform || '?') + '] ' +
      (p.type ? p.type + ' - ' : '') +
      (p.engagement || 0) + ' eng' +
      (p.reach ? ', ' + p.reach + ' reach' : '') +
      (p.comments ? ', ' + p.comments + ' comments' : '') +
      ' :: ' + (p.text || '').replace(/\s+/g, ' ').slice(0, 280)
    );
  });
  lines.push('');
  lines.push('Sample of audience comments (text and auto-computed sentiment 0-100, 50=neutral):');
  comments.forEach(function(c) {
    lines.push('- [' + (c.platform || '?') + (c.score != null ? ', s=' + c.score : '') + '] ' + c.text);
  });
  lines.push('');
  lines.push('Return a single valid JSON object matching this exact shape. No code fences, no prose outside JSON.');
  lines.push('{');
  lines.push('  "whatHappened": "A rich, multi-paragraph narrative (4-7 sentences total, split across 2 paragraphs using a blank line). Paragraph 1: the overall performance pattern of this window, naming the platform(s) that drove it and citing specific numbers. Paragraph 2: the most interesting behavioral observation — what the audience responded to, how comment sentiment read, what stood out vs prior period. Write like an editor briefing the team; concrete and specific, not a generic recap.",');
  lines.push('  "whatsWorking": [');
  lines.push('    { "title": "Short descriptive name (3-6 words)", "platform": "fb | ig | li | yt | mixed", "evidence": "specific metric or post reference, e.g. \\"846 engagements on a single post\\"", "why": "One sentence on why this performed — audience behavior, format, timing, topic resonance" }');
  lines.push('    // 3 items');
  lines.push('  ],');
  lines.push('  "nextMoves": [');
  lines.push('    { "title": "Short imperative action (4-8 words, e.g. \\"Cross-post Falcon Cam to Instagram Reels\\")", "rationale": "Why this based on what we observed in the data", "impact": "Expected outcome — be specific and modest (e.g. \\"Test lift in IG video reach, since current IG reach is unreported\\")" }');
  lines.push('    // 3 items — must be implementable within a week');
  lines.push('  ],');
  lines.push('  "watchOuts": [');
  lines.push('    "Short flag about a data gap, concerning trend, or audience signal worth monitoring. 1-2 items max. Empty array is fine if nothing concerning."');
  lines.push('  ]');
  lines.push('}');
  return lines.join('\n');
}

// Parse a JSON object out of an LLM response, tolerating markdown fences and prose wrapping.
function parseInsightsJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {}
  // Strip ```json ... ``` fences and try again
  const fenced = raw.match(/\{[\s\S]*\}/);
  if (fenced) {
    try { return JSON.parse(fenced[0]); } catch (e) {}
  }
  return null;
}

function shapeInsightsResult(parsed) {
  // Normalize winning plays and next moves — accept either the new object form
  // or the older plain-string array for backward compat.
  function normalizeWorking(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function(item) {
      if (typeof item === 'string') return { title: item, platform: '', evidence: '', why: '' };
      return {
        title: String(item.title || ''),
        platform: String(item.platform || '').toLowerCase(),
        evidence: String(item.evidence || item.metric || ''),
        why: String(item.why || item.reason || '')
      };
    });
  }
  function normalizeMoves(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function(item) {
      if (typeof item === 'string') return { title: item, rationale: '', impact: '' };
      return {
        title: String(item.title || ''),
        rationale: String(item.rationale || item.why || ''),
        impact: String(item.impact || item.expectedImpact || '')
      };
    });
  }
  function normalizeStats(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 4).map(function(s) {
      return {
        label: String(s.label || ''),
        value: String(s.value || ''),
        delta: s.delta == null ? null : String(s.delta),
        direction: ['up', 'down', 'neutral'].indexOf(s.direction) >= 0 ? s.direction : 'neutral',
        context: String(s.context || '')
      };
    });
  }
  return {
    headline: String(parsed.headline || ''),
    stats: normalizeStats(parsed.stats),
    whatHappened: String(parsed.whatHappened || parsed.summary || ''),
    // Back-compat: if old clients still send `whatsWorking` as strings, keep them
    whatsWorking: normalizeWorking(parsed.whatsWorking || parsed.working),
    nextMoves: normalizeMoves(parsed.nextMoves || parsed.whatToTry || parsed.recommendations),
    watchOuts: Array.isArray(parsed.watchOuts) ? parsed.watchOuts.map(String).slice(0, 3) : []
  };
}

async function callAnthropicInsights(apiKey, userPrompt) {
  const model = process.env.INSIGHTS_MODEL || CLAUDE_MODEL_DEFAULT;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 1200,
      system: INSIGHTS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.warn(' [INSIGHTS] Anthropic API error:', resp.status, errText.slice(0, 300));
    throw new Error('Claude API error (' + resp.status + ')');
  }
  const payload = await resp.json();
  return (payload.content && payload.content[0] && payload.content[0].text) || '';
}

async function callGeminiInsights(apiKey, userPrompt) {
  const model = process.env.INSIGHTS_MODEL || GEMINI_MODEL_DEFAULT;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: INSIGHTS_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 1200,
        responseMimeType: 'application/json'
      }
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.warn(' [INSIGHTS] Gemini API error:', resp.status, errText.slice(0, 300));
    throw new Error('Gemini API error (' + resp.status + ')');
  }
  const payload = await resp.json();
  const parts = payload.candidates && payload.candidates[0] &&
                payload.candidates[0].content && payload.candidates[0].content.parts;
  return (parts && parts[0] && parts[0].text) || '';
}

// ============================================================
// AUDIENCE PULSE — weekly Reddit + Bluesky sentiment scan
// GET  /api/pulse        → returns the cached weekly summary (regenerates if a new week has started)
// GET  /api/pulse/cached → returns whatever's on disk without ever triggering a regeneration
// ============================================================
app.get('/api/pulse', async (req, res) => {
  try {
    const data = await pulse.getPulseData(false);
    res.json(data);
  } catch (err) {
    console.warn(' [PULSE] /api/pulse error:', err.message);
    res.status(500).json({ error: err.message || 'Pulse generation failed' });
  }
});

app.get('/api/pulse/cached', (req, res) => {
  const cached = pulse.getCachedPulse();
  if (!cached) return res.json({ weekId: null, generatedAt: null, themes: [], pending: true });
  res.json(cached);
});

// Diagnostic endpoint — checks env var presence and tests Claude with a tiny call.
// Use when summaries are failing to pinpoint the actual error message.
app.get('/api/pulse/diag', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const out = {
    anthropicKeyPresent: !!anthropicKey,
    anthropicKeyPrefix: anthropicKey ? anthropicKey.slice(0, 10) + '...' : null,
    anthropicKeyLength: anthropicKey ? anthropicKey.length : 0,
    geminiKeyPresent: !!geminiKey,
    geminiKeyLength: geminiKey ? geminiKey.length : 0,
    nodeEnv: process.env.NODE_ENV || 'not-set'
  };
  if (anthropicKey) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Reply with just the word OK.' }]
        })
      });
      out.claudeStatus = r.status;
      if (r.ok) {
        const j = await r.json();
        out.claudeReply = (j.content && j.content[0] && j.content[0].text) || '(no content)';
        out.claudeOk = true;
      } else {
        const errText = await r.text();
        out.claudeOk = false;
        out.claudeError = errText.slice(0, 600);
      }
    } catch (e) { out.claudeOk = false; out.claudeException = e.message; }
  }
  res.json(out);
});

// Manual regeneration — bypasses the weekly cache. Rate-limited so it can't
// be hammered. Useful for testing changes without waiting for the next week.
let _lastManualPulseRegen = 0;
app.post('/api/pulse/regenerate', async (req, res) => {
  const now = Date.now();
  if (now - _lastManualPulseRegen < 60000) {
    return res.status(429).json({ error: 'Manual regeneration is rate-limited to once per minute.' });
  }
  _lastManualPulseRegen = now;
  // Kick off generation but don't make the client wait — return immediately.
  pulse.forceRegenerate().catch(err => console.warn(' [PULSE] Manual regen error:', err.message));
  res.json({ ok: true, message: 'Regeneration started. Reload /api/pulse/cached in ~60-90s.' });
});

// 24h fingerprint cache for AI Insights — avoids regenerating the same view
// repeatedly throughout the day (and across users). Keyed by SHA1 of the request body.
const INSIGHTS_CACHE_FILE = path.join(__dirname, 'insights-cache.json');
const INSIGHTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function _loadInsightsCache() {
  try {
    if (!fs.existsSync(INSIGHTS_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(INSIGHTS_CACHE_FILE, 'utf8')) || {};
  } catch (e) { return {}; }
}
function _saveInsightsCache(obj) {
  try { fs.writeFileSync(INSIGHTS_CACHE_FILE, JSON.stringify(obj), 'utf8'); }
  catch (e) { console.warn(' [INSIGHTS] cache save failed:', e.message); }
}
function _insightsFingerprint(body) {
  const crypto = require('crypto');
  // Stable serialization: stringify with sorted keys
  const stable = JSON.stringify(body, Object.keys(body || {}).sort());
  return crypto.createHash('sha1').update(stable).digest('hex');
}

app.post('/api/insights', express.json({ limit: '1mb' }), async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!anthropicKey && !geminiKey) {
    return res.status(503).json({
      error: 'No LLM API key configured. Add GEMINI_API_KEY (free, get at aistudio.google.com) ' +
             'or ANTHROPIC_API_KEY to Render env vars.'
    });
  }
  const body = req.body || {};
  if (!body.metrics || body.metrics.postCount === 0) {
    return res.status(400).json({ error: 'No posts in the requested window.' });
  }

  // 24h fingerprint cache lookup
  const fp = _insightsFingerprint(body);
  const cache = _loadInsightsCache();
  const cached = cache[fp];
  if (cached && (Date.now() - cached.cachedAt) < INSIGHTS_CACHE_TTL_MS) {
    const result = Object.assign({}, cached.result, { _cached: true, _cachedAt: cached.cachedAt });
    return res.json(result);
  }

  try {
    const userPrompt = buildInsightsUserPrompt(body);
    // Prefer Claude (paid, reliable) — falls back to Gemini if Claude errors.
    let provider = 'anthropic';
    let raw;
    if (anthropicKey) {
      try {
        raw = await callAnthropicInsights(anthropicKey, userPrompt);
      } catch (e) {
        if (geminiKey) {
          console.warn(' [INSIGHTS] Claude failed, falling back to Gemini:', e.message);
          provider = 'gemini';
          raw = await callGeminiInsights(geminiKey, userPrompt);
        } else {
          throw e;
        }
      }
    } else {
      provider = 'gemini';
      raw = await callGeminiInsights(geminiKey, userPrompt);
    }

    const parsed = parseInsightsJson(raw);
    if (!parsed) {
      return res.status(502).json({
        error: 'Model returned unparseable output.',
        provider: provider,
        raw: (raw || '').slice(0, 500)
      });
    }
    const result = shapeInsightsResult(parsed);
    result._provider = provider;

    // Save to cache (prune entries older than TTL while we're here)
    const fresh = {};
    const now = Date.now();
    for (const [k, v] of Object.entries(cache)) {
      if (v && v.cachedAt && (now - v.cachedAt) < INSIGHTS_CACHE_TTL_MS) fresh[k] = v;
    }
    fresh[fp] = { result: result, cachedAt: now };
    _saveInsightsCache(fresh);

    return res.json(result);
  } catch (err) {
    console.warn(' [INSIGHTS] Server error:', err.message);
    return res.status(500).json({ error: err.message || 'Insights generation failed' });
  }
});


// ============================================================
// AI COMMENT SCORING — context-aware sentiment via Claude Haiku 4.5
// POST /api/score-comments with { items: [{id, post, parent?, text}, ...] }
// Returns: { scores: [{id, score, label, rationale}, ...] }
// Frontend caches per comment-id in localStorage, so steady-state cost is near zero.
// ============================================================
const COMMENT_SCORING_MODEL = process.env.COMMENT_SCORING_MODEL || 'claude-haiku-4-5-20251001';
const COMMENT_SCORING_MAX_BATCH = 12;

const COMMENT_SCORING_SYSTEM = [
  'You are a sentiment analyst for Madison Gas and Electric (MGE), a Wisconsin utility company.',
  'For each social media comment, return a sentiment score on a CONTINUOUS 0-100 scale reflecting the commenter\'s stance toward MGE / the topic of the post.',
  '',
  'CRITICAL — granularity requirement:',
  'You MUST use the full 0-100 range. DO NOT round to 0, 25, 50, 75, or 100. Those are anchor points only — almost every real comment lands BETWEEN them.',
  'Use any integer 0-100. Distinguish a mild complaint (38) from a harsh attack (12). Distinguish quiet agreement (62) from enthusiastic defense (88). Distinguish a clarifying question (52) from a passive-aggressive question (34).',
  'If your first instinct is to write 25/50/75/100, STOP and pick a more specific number that captures the actual intensity.',
  '',
  'Anchor points (NOT the only allowed values):',
  '   5-15  = vitriolic, profane, attacks on MGE / staff / clean energy',
  '  16-35  = clearly negative, frustrated complaints, accusations',
  '  36-49  = mildly negative, grumbling, skeptical questioning',
  '     50  = truly neutral (rare — pure factual question, totally off-topic)',
  '  51-64  = mildly positive, polite agreement, "thanks for the info"',
  '  65-84  = clearly positive, supportive, defending MGE\'s position',
  '  85-95  = enthusiastic support, story-form defense, evangelizing on MGE\'s behalf',
  '  96-100 = exceptional praise + active defense against critics',
  '',
  'Scoring approach (think before you score):',
  '1. Read the original post — what is its angle? (pro-EV? a rate change? an outage update? a community feature?)',
  '2. If a parent comment is provided, this comment is a REPLY — read the parent first to understand what this commenter is responding to.',
  '3. Read the comment. What is the commenter\'s STANCE toward MGE/the topic? Stance is what matters — not literal word positivity.',
  '4. Gauge intensity. A whisper of support is 58, not 75. A scream of support is 92, not 100. Match the intensity precisely.',
  '5. Pick the specific integer that captures both stance + intensity.',
  '',
  'Common context traps to avoid:',
  '- A long EV-ownership story defending an EV post is STRONGLY POSITIVE (85-92), even without naming MGE, even if it mentions "expensive gas I no longer pay" or "cold winter range".',
  '- Sarcasm flips literal sentiment. "Wow, great job MGE 🙄" is 15-25, not 80.',
  '- "Actually, you\'re wrong, here\'s why MGE is right" defending MGE in a reply is 80-90.',
  '- Pure factual questions with no implied stance are 50, but loaded questions ("why does MGE keep raising rates?") are 30-40.',
  '- Jokes and off-topic banter are usually 48-55 unless they target MGE.',
  '',
  'Label must be one of: Strongly Negative, Negative, Neutral, Positive, Strongly Positive',
  '  (label maps to score: <30 Strongly Negative; 30-44 Negative; 45-55 Neutral; 56-74 Positive; >=75 Strongly Positive)',
  'Rationale must be one short sentence (max ~14 words) in plain English explaining what drove the score.',
  '',
  'Output ONLY a JSON array. No preamble, no markdown, no commentary. Format:',
  '[{"id":"<id>","score":<integer 0-100, NOT a multiple of 25>,"label":"<label>","rationale":"<one short sentence>"}, ...]',
  '',
  'Example outputs (note the granular scores — never multiples of 25):',
  '  {"id":"abc","score":18,"label":"Strongly Negative","rationale":"Hostile attack on MGE leadership with profanity."}',
  '  {"id":"def","score":42,"label":"Negative","rationale":"Mild complaint about a recent rate increase."}',
  '  {"id":"ghi","score":53,"label":"Neutral","rationale":"Factual question about an outage timeline."}',
  '  {"id":"jkl","score":67,"label":"Positive","rationale":"Polite thank-you for clear communication."}',
  '  {"id":"mno","score":88,"label":"Strongly Positive","rationale":"Long personal story defending EV ownership against a skeptic."}'
].join('\n');

function buildCommentScoringPrompt(items) {
  const rows = items.map((it, idx) => {
    const lines = ['ITEM #' + (idx + 1)];
    lines.push('id: ' + JSON.stringify(it.id));
    if (it.post) lines.push('post: ' + JSON.stringify(String(it.post).slice(0, 400)));
    if (it.parent) lines.push('parent_comment (this is a REPLY to): ' + JSON.stringify(String(it.parent).slice(0, 300)));
    lines.push('comment: ' + JSON.stringify(String(it.text || '').slice(0, 1500)));
    return lines.join('\n');
  });
  return 'Score each comment below. Return one JSON object per item, in the same order, in a single JSON array.\n\n' + rows.join('\n\n');
}

async function callAnthropicScoring(apiKey, userPrompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: COMMENT_SCORING_MODEL,
      max_tokens: 2048,
      system: COMMENT_SCORING_SYSTEM,
      messages: [
        { role: 'user', content: userPrompt },
        // Pre-fill the assistant turn with `[` to force JSON-array output
        { role: 'assistant', content: '[' }
      ]
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.warn(' [SCORE] Anthropic API error:', resp.status, errText.slice(0, 300));
    throw new Error('Claude API error (' + resp.status + ')');
  }
  const payload = await resp.json();
  const text = (payload.content && payload.content[0] && payload.content[0].text) || '';
  // We pre-filled `[`, so the model continues from there. Re-add the leading bracket.
  return '[' + text;
}

function parseScoringJson(raw) {
  if (!raw) return null;
  // Trim to the outermost JSON array
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
    return arr.map(o => ({
      id: String(o.id),
      score: Math.max(0, Math.min(100, Math.round(Number(o.score) || 50))),
      label: String(o.label || 'Neutral').slice(0, 32),
      rationale: String(o.rationale || '').slice(0, 200)
    }));
  } catch (e) {
    console.warn(' [SCORE] JSON parse failed:', e.message, 'raw:', raw.slice(0, 200));
    return null;
  }
}

app.post('/api/score-comments', express.json({ limit: '512kb' }), async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length) return res.json({ scores: [] });
  if (items.length > COMMENT_SCORING_MAX_BATCH) {
    return res.status(400).json({ error: 'Batch too large; max ' + COMMENT_SCORING_MAX_BATCH + ' items per request' });
  }
  // Defensive normalization
  const clean = items.map(it => ({
    id: String(it.id || ''),
    post: it.post ? String(it.post) : '',
    parent: it.parent ? String(it.parent) : '',
    text: String(it.text || '')
  })).filter(it => it.id && it.text);
  if (!clean.length) return res.json({ scores: [] });

  try {
    const userPrompt = buildCommentScoringPrompt(clean);
    const raw = await callAnthropicScoring(anthropicKey, userPrompt);
    const parsed = parseScoringJson(raw);
    if (!parsed) {
      return res.status(502).json({ error: 'Model returned unparseable output', raw: raw.slice(0, 300) });
    }
    // Reconcile: only return scores whose id was in the request
    const validIds = new Set(clean.map(c => c.id));
    const scores = parsed.filter(s => validIds.has(s.id));
    return res.json({ scores: scores, model: COMMENT_SCORING_MODEL });
  } catch (err) {
    console.warn(' [SCORE] Server error:', err.message);
    return res.status(500).json({ error: err.message || 'Scoring failed' });
  }
});



// ============================================================
// STORIES — Instagram + Facebook Stories capture
// Live read endpoints, archive read, manual capture trigger.
// 12-hour automated poller starts in app.listen below.
// ============================================================

// Active stories on Instagram with live insights (no archive write)
app.get('/api/instagram/stories', async (req, res) => {
  const data = await stories.fetchInstagramStories(config);
  res.json(data);
});

// Active stories on Facebook with live insights (no archive write)
app.get('/api/facebook/stories', async (req, res) => {
  const data = await stories.fetchFacebookStories(config);
  res.json(data);
});

// Full archive (everything captured so far across both platforms)
app.get('/api/stories/archive', (req, res) => {
  const archive = stories.loadArchive();
  // Return as a sorted array, newest first by postedAt
  const arr = Object.values(archive.stories).sort((a, b) => {
    const ta = new Date(a.postedAt || 0).getTime();
    const tb = new Date(b.postedAt || 0).getTime();
    return tb - ta;
  });
  res.json({
    lastUpdatedAt: archive.lastUpdatedAt,
    total: arr.length,
    stories: arr
  });
});

// Status of last automated capture run
app.get('/api/stories/status', (req, res) => {
  res.json({
    lastResult: stories.getLastResult(),
    pollIntervalHours: stories.POLL_INTERVAL_MS / 3600000,
    archiveBranch: stories.ARCHIVE_BRANCH,
    archiveRepo: stories.ARCHIVE_REPO,
    githubCommitEnabled: !!process.env.GITHUB_PAT
  });
});

// Manual capture trigger — fetches active stories now, archives, optionally commits
// Useful when you have stories live that you want captured immediately.
app.post('/api/stories/refresh', async (req, res) => {
  const result = await stories.runStoryCapture(config);
  res.json(result);
});
// Allow GET for convenience (browser / curl one-liner)
app.get('/api/stories/refresh', async (req, res) => {
  const result = await stories.runStoryCapture(config);
  res.json(result);
});


// ============================================================
// Facebook Page Ratings API
// ============================================================


let _fbReviewsCache     = null;
let _fbReviewsCacheTime = 0;
const FB_REVIEWS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Detect obvious spam reviews (crypto/forex scams, phishing, investment pitches)
function _fbIsSpam(comment) {
  if (!comment) return false;
  const t = comment.toLowerCase();
  if (/\bforex\b|\bbitcoin\b|\bcrypto\b/.test(t)) return true;
  if (/whatsapp\s*[:\-]\s*\+?\d/.test(t)) return true;
  if (/e[-\s]?mail\s*[:\-]\s*\S+@\S+/.test(t)) return true;
  if (/invest\w*\s+\$\d+/.test(t) || /\$\d[\d,]+.*\bprofit\b/.test(t)) return true;
  if (/page.{0,40}scheduled.{0,40}deletion/.test(t)) return true;
  if (/\btrader\b.*\bwithdraw|\bwithdraw\b.*\bprofit\b/.test(t)) return true;
  return false;
}

app.get('/api/fb-reviews', async (req, res) => {
  const cfg = config.facebook;
  if (!cfg || !cfg.enabled || !cfg.pageAccessToken || !cfg.pageId) {
    return res.json({ error: 'Facebook not configured', reviews: [] });
  }

  // Serve from cache if fresh
  if (_fbReviewsCache && (Date.now() - _fbReviewsCacheTime) < FB_REVIEWS_CACHE_TTL) {
    return res.json(_fbReviewsCache);
  }

  try {
    const rawReviews = [];
    const fields = 'created_time,has_rating,has_review,rating,recommendation_type,review_text,reviewer';
    let url = `https://graph.facebook.com/v19.0/${cfg.pageId}/ratings?fields=${fields}&limit=100&access_token=${cfg.pageAccessToken}`;

    // Paginate up to 3 pages (max 300 reviews)
    for (let page = 0; page < 3 && url; page++) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`FB Ratings API ${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      if (data.error) throw new Error(`FB Ratings API error: ${data.error.message}`);
      (data.data || []).forEach(r => {
        // Include all entries — even text-free recommendations are valid customer signals
        rawReviews.push({
          createTime: r.created_time,
          // Facebook uses recommendations (positive/negative), not star ratings
          // Map to 5/1 for sorting/filtering purposes
          starRating: r.recommendation_type === 'positive' ? 5
                    : r.recommendation_type === 'negative' ? 1 : 0,
          recommendationType: r.recommendation_type || null, // 'positive' | 'negative'
          reviewer: { displayName: r.reviewer?.name || 'Facebook User' },
          comment: r.review_text || '',
          reviewReply: null,
          source: 'facebook'
        });
      });
      url = data.paging?.next || null;
    }

    // Filter out obvious spam (crypto/forex scams, phishing messages)
    const reviews = rawReviews.filter(r => !_fbIsSpam(r.comment));
    const spamCount = rawReviews.length - reviews.length;
    if (spamCount > 0) console.log(`[FB Reviews] Filtered ${spamCount} spam review(s)`);

    const result = { reviews, totalReviews: reviews.length, fetchedAt: new Date().toISOString() };
    _fbReviewsCache     = result;
    _fbReviewsCacheTime = Date.now();
    console.log(`[FB Reviews] Returning ${reviews.length} reviews for page ${cfg.pageId}`);
    res.json(result);
  } catch (err) {
    console.error('[FB Reviews] Error:', err.message);
    res.status(500).json({ error: err.message, reviews: [] });
  }
});

// ============================================================

const PORT = config.server.port;
app.listen(PORT, () => {
  console.log('');
  console.log(' +==================================================+');
  console.log(' |  MGE Social Media Command Center v2.0            |');
  console.log(' |  Engagement & Sentiment Monitoring Dashboard     |');
  console.log(' +==================================================+');
  console.log('');
  console.log(` [WEB] Dashboard: http://localhost:${PORT}`);
  if (DASHBOARD_PASSWORD) console.log(` [LOCK] Password protection enabled (use ?pw=<password>)`);
  console.log('');
  console.log(' Platform Status:');
  console.log(`   YouTube    ${config.youtube?.enabled ? '[OK] Configured' : '[ ] Not configured'}`);
  console.log(`   Facebook   ${config.facebook?.enabled ? '[OK] Configured' : '[ ] Not configured'}`);
  console.log(`   Instagram  ${config.instagram?.enabled ? '[OK] Configured' : '[ ] Not configured'}`);
  console.log(`   LinkedIn   ${config.linkedin?.enabled ? '[OK] Configured' : '[ ] Not configured'}`);
  console.log(`   GBP Reviews${config.googleReviews?.enabled ? '[OK] Configured' : '[ ] Pending GBP API access approval'}`);
  console.log('');
  // Audience Pulse: trigger background generation if cache is empty or stale (week rollover)
  pulse.maybeBackgroundGenerate();
  // Stories: 12-hour poller for IG + FB story capture (commits archive to data-archive branch on GitHub)
  stories.startStoryPoller(() => config);
});
