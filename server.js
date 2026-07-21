require('dotenv').config();

const path     = require('path');
const { Readable } = require('stream');
const multer  = require('multer');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const { google } = require('googleapis');

const app = express();

// Trust Replit's reverse proxy so secure cookies and redirects work correctly
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,      // required when served over HTTPS through Replit's proxy
    sameSite: 'none'   // allows cookie to survive the OAuth cross-origin redirect
  }
}));

// Accept either ADMIN_EMAIL or the legacy COUNCIL_GMAIL_ACCOUNT secret
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || process.env.COUNCIL_GMAIL_ACCOUNT || '').toLowerCase();

// ============================================================
// HELPER — build an OAuth2 client, optionally with stored tokens
// ============================================================
function buildOAuthClient(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  if (tokens) client.setCredentials(tokens);
  return client;
}

// Scopes requested at login.
// gmail.readonly is added for Test 2 — Gmail read test.
// NOTE: You must enable the Gmail API in Google Cloud Console
//       and add this scope to your OAuth consent screen,
//       then sign out and sign back in to grant it.
const oauthScopes = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  // Test 5 — Drive folder creation.
  // Requires: Enable Google Drive API in Cloud Console,
  // add this scope to OAuth consent screen, sign out & sign back in.
  'https://www.googleapis.com/auth/drive'
];

// ============================================================
// MIDDLEWARE — require signed-in admin
// ============================================================
function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  if (req.session.user.email.toLowerCase() !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

// ============================================================
// ROUTE: GET /health
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: process.env.APP_NAME || 'KofC Blog Admin',
    adminEmailConfigured: ADMIN_EMAIL,
    timestamp: new Date()
  });
});

// ============================================================
// ROUTE: GET /auth/google — start OAuth flow
// ============================================================
app.get('/auth/google', (req, res) => {
  const client = buildOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',    // request refresh token so Gmail calls survive token expiry
    scope: oauthScopes,
    prompt: 'select_account'   // always show account picker
  });
  res.redirect(url);
});

// ============================================================
// ROUTE: GET /auth/google/callback
// ============================================================
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing OAuth code');

    const client = buildOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2Api = google.oauth2({ auth: client, version: 'v2' });
    const userInfo  = await oauth2Api.userinfo.get();

    const email = (userInfo.data.email || '').toLowerCase();
    const name  = userInfo.data.name || '';

    console.log('Google login email:', email);
    console.log('Allowed admin email:', ADMIN_EMAIL);

    if (email !== ADMIN_EMAIL) {
      req.session.denied = email;
      console.log('Access denied for:', email);
      return res.redirect('/');
    }

    req.session.denied = null;
    req.session.user   = { email, name };
    req.session.tokens = tokens;   // store tokens for Gmail API calls

    // Explicitly save the session before redirecting so the cookie is guaranteed
    // to be persisted before the browser follows the redirect to /
    req.session.save((err) => {
      if (err) {
        console.error('Session save failed:', err);
        return res.status(500).send('Session save failed.');
      }
      res.redirect('/');
    });
  } catch (err) {
    console.error('OAuth failed:', err);
    res.status(500).send('OAuth failed. Check Replit console logs.');
  }
});

// ============================================================
// ROUTE: GET /api/me
// ============================================================

app.get('/api/me', (req, res) => {
  const denied = req.session.denied || null;
  if (denied) req.session.denied = null;

  console.log('[/api/me] session id:', req.sessionID, '| user:', req.session.user ? req.session.user.email : 'NONE');

  if (!req.session.user) {
    return res.json({ loggedIn: false, denied });
  }

  res.json({
    loggedIn: true,
    user: req.session.user,
    isAdmin: req.session.user.email.toLowerCase() === ADMIN_EMAIL,
    hasGmailToken: !!(req.session.tokens && req.session.tokens.access_token),
    denied: null
  });
});

// ============================================================
// ROUTE: GET /api/admin-test
// ============================================================
app.get('/api/admin-test', requireAdmin, (req, res) => {
  res.json({ message: 'Admin access confirmed', user: req.session.user });
});

// ============================================================
// HELPER — extract summary fields from a full Gmail message
// ============================================================
function buildEmailSummary(detail) {
  const headers = detail.data.payload.headers || [];
  const getHeader = name =>
    (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

  let attachmentCount = 0;
  function countAttachments(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.filename && part.filename.length > 0) attachmentCount++;
      if (part.parts) countAttachments(part.parts);
    }
  }
  countAttachments(detail.data.payload.parts);

  return {
    id:              detail.data.id,
    date:            getHeader('Date'),
    sender:          getHeader('From'),
    subject:         getHeader('Subject') || '(no subject)',
    attachmentCount
  };
}

// ============================================================
// ROUTE: GET /api/gmail/recent
// ============================================================
// Returns emails whose subject contains "blob" (case-insensitive).
// ============================================================
app.get('/api/gmail/recent', requireAdmin, async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({
      error: 'No Gmail token found. Please sign out and sign back in.'
    });
  }

  try {
    const client = buildOAuthClient(req.session.tokens);

    client.on('tokens', (newTokens) => {
      req.session.tokens = { ...req.session.tokens, ...newTokens };
    });

    const gmail = google.gmail({ version: 'v1', auth: client });

    const all = req.query.all === 'true';
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 50,
      q: all ? '' : 'subject:blog'
    });

    const messageList = listRes.data.messages || [];
    if (messageList.length === 0) {
      return res.json({ emails: [] });
    }

    const messageDetails = await Promise.all(
      messageList.map(msg =>
        gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' })
      )
    );

    const emails = messageDetails.map(detail => buildEmailSummary(detail));
    console.log(`Gmail (subject): ${emails.length} emails`);
    res.json({ emails });

  } catch (err) {
    console.error('Gmail API error:', err.message);
    if (err.response) {
      console.error('Gmail API response:', JSON.stringify(err.response.data));
    }
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: POST /api/gmail/apply-label
// Body: { messageId }
// Finds label 'blog---published' by name and applies it to the message.
// ============================================================
app.post('/api/gmail/apply-label', requireAdmin, async (req, res) => {
  const { messageId } = req.body;
  if (!messageId) return res.status(400).json({ error: 'Missing messageId' });

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const gmail = google.gmail({ version: 'v1', auth: client });

    const labelsRes = await gmail.users.labels.list({ userId: 'me' });
    const label = (labelsRes.data.labels || []).find(l => l.name === 'blog---published');
    if (!label) {
      console.warn('apply-label: label "blog---published" not found in Gmail');
      return res.status(404).json({ error: 'Label "blog---published" not found in Gmail' });
    }

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { addLabelIds: [label.id] }
    });

    console.log(`Gmail: applied label "${label.name}" to message ${messageId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('apply-label error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HELPER — Test 4: generate Google Drive folder name suggestions
// from an email subject and date.
// ============================================================
function suggestFolderNames(subject, dateStr) {
  // Parse date for YYYY-MM prefix
  const d = new Date(dateStr);
  const hasDate = !isNaN(d.getTime());
  const yyyymm = hasDate
    ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    : null;

  // Strip words / patterns that shouldn't appear in a folder name
  let cleaned = subject
    .replace(/\[?blogs?\]?/gi, ' ')           // blog, blogs, [blog]
    .replace(/council\s+4599/gi, ' ')          // council 4599
    .replace(/\bcouncil\b/gi, ' ')             // standalone "council"
    .replace(/\bko?f?c\s*\d*/gi, ' ')          // KofC, kofc, KC, KofC 4599
    .replace(/\b(submission|submitted|submit)\b/gi, ' ')
    .replace(/[-–—|]+/g, ' ')                 // dashes / pipes
    .replace(/\s+/g, ' ')
    .trim();

  // Title-case
  cleaned = cleaned.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

  // Strip leading / trailing punctuation left over
  cleaned = cleaned.replace(/^[\s\-–—,:;]+|[\s\-–—,:;]+$/g, '').trim();

  if (!cleaned) cleaned = 'Blog Post';

  const primary   = yyyymm ? yyyymm + ' ' + cleaned : cleaned;
  const altNoDate = yyyymm ? cleaned : null;
  const altYear   = hasDate ? String(d.getFullYear()) + ' ' + cleaned : null;

  return {
    primary,
    nameOnly:   cleaned,   // just the event name, no date prefix
    alternates: [altNoDate, altYear].filter(Boolean)
  };
}

// ============================================================
// ROUTE: GET /api/gmail/message/:id  — Test 3: email detail
// ============================================================
// Returns full detail for one message:
//   from, to, cc, date, subject, bodyText, attachments[]
// ============================================================
app.get('/api/gmail/message/:id', requireAdmin, async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'No Gmail token. Please sign out and sign back in.' });
  }

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', (t) => { req.session.tokens = { ...req.session.tokens, ...t }; });

    const gmail = google.gmail({ version: 'v1', auth: client });

    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: req.params.id,
      format: 'full'
    });

    const headers = detail.data.payload.headers || [];
    const getHeader = name =>
      (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

    // Walk the MIME tree to extract plain-text body and attachments
    let bodyText = '';
    let bodyHtml  = '';
    const attachments = [];

    function walkParts(payload) {
      if (!payload) return;

      const mime = payload.mimeType || '';
      const data = payload.body && payload.body.data;

      if (mime === 'text/plain' && data && !bodyText) {
        bodyText = Buffer.from(data, 'base64url').toString('utf-8');
      } else if (mime === 'text/html' && data && !bodyHtml) {
        bodyHtml = Buffer.from(data, 'base64url').toString('utf-8');
      }

      if (payload.filename && payload.filename.length > 0) {
        attachments.push({
          filename: payload.filename,
          mimeType: mime,
          size: payload.body ? (payload.body.size || 0) : 0
        });
      }

      if (payload.parts) payload.parts.forEach(walkParts);
    }

    walkParts(detail.data.payload);

    // Prefer plain text; fall back to stripping HTML tags
    let body = bodyText;
    if (!body && bodyHtml) {
      body = bodyHtml
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
    }
    if (!body) body = '(no body)';

    const subject = getHeader('Subject') || '(no subject)';
    const date    = getHeader('Date');
    const folder  = suggestFolderNames(subject, date);

    res.json({
      id: detail.data.id,
      date,
      from:    getHeader('From'),
      to:      getHeader('To'),
      cc:      getHeader('Cc'),
      subject,
      body:    body.substring(0, 6000),
      attachments,
      folderSuggestion: folder          // Test 4 data
    });

  } catch (err) {
    console.error('Gmail detail error:', err.message);
    if (err.response) console.error('Gmail response:', JSON.stringify(err.response.data));
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HELPER — walk path root → album → dest, return { rootId, albumId, destId }
// ============================================================
async function walkDrivePath(drive, driveOpts, rootName, albumName, folderName) {
  // Step 1 — list My Drive top-level folders
  const step1 = await drive.files.list({
    q: `'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)', spaces: 'drive', pageSize: 100, ...driveOpts
  });
  const rootFolder = step1.data.files.find(f => f.name === rootName);
  if (!rootFolder) {
    const names = step1.data.files.map(f => `"${f.name}"`).join(', ') || '(none)';
    throw Object.assign(new Error(`"${rootName}" not found at My Drive root. Top-level folders: ${names}`), { status: 404 });
  }

  // Step 2 — list subfolders of root
  const step2 = await drive.files.list({
    q: `'${rootFolder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)', spaces: 'drive', pageSize: 100, ...driveOpts
  });
  const albumFolder = step2.data.files.find(f => f.name === albumName);
  if (!albumFolder) {
    const names = step2.data.files.map(f => `"${f.name}"`).join(', ') || '(none)';
    throw Object.assign(new Error(`"${albumName}" not found inside "${rootName}". Subfolders: ${names}`), { status: 404 });
  }

  // Step 3 — list subfolders of album (optional dest)
  if (!folderName) return { rootId: rootFolder.id, albumId: albumFolder.id, destId: null };

  const step3 = await drive.files.list({
    q: `'${albumFolder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)', spaces: 'drive', pageSize: 100, ...driveOpts
  });
  const destFolder = step3.data.files.find(f => f.name === folderName);
  if (!destFolder) {
    const names = step3.data.files.map(f => `"${f.name}"`).join(', ') || '(none)';
    throw Object.assign(new Error(`"${folderName}" not found inside "${albumName}". Subfolders: ${names}`), { status: 404 });
  }
  return { rootId: rootFolder.id, albumId: albumFolder.id, destId: destFolder.id };
}

// ============================================================
// ROUTE: GET /api/drive/list-albums
// Returns all album subfolders inside "Council Activities".
// ============================================================
app.get('/api/drive/list-albums', requireAdmin, async (req, res) => {
  const rootName = 'Council Activities';
  const esc = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });

    const rootRes = await drive.files.list({
      q: `name = '${esc(rootName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 5
    });
    if (!rootRes.data.files.length) {
      return res.status(404).json({ error: 'Council Activities folder not found' });
    }
    const rootId = rootRes.data.files[0].id;

    const albumRes = await drive.files.list({
      q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: 'name desc',
      pageSize: 50
    });
    res.json({ albums: albumRes.data.files.map(f => ({ id: f.id, name: f.name })) });
  } catch (err) {
    console.error('list-albums error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: GET /api/drive/list-events?albumId=...
// Returns all event subfolders inside a given album folder.
// ============================================================
app.get('/api/drive/list-events', requireAdmin, async (req, res) => {
  const { albumId } = req.query;
  if (!albumId) return res.status(400).json({ error: 'Missing albumId' });
  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });

    const evRes = await drive.files.list({
      q: `'${albumId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: 'name desc',
      pageSize: 100
    });
    res.json({ events: evRes.data.files.map(f => ({ id: f.id, name: f.name })) });
  } catch (err) {
    console.error('list-events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: GET /api/drive/event-detail?folderId=...
// Returns photos + description text for one event folder.
// ============================================================
app.get('/api/drive/event-detail', requireAdmin, async (req, res) => {
  const { folderId } = req.query;
  if (!folderId) return res.status(400).json({ error: 'Missing folderId' });
  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });

    const filesRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, description)',
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: 'name asc',
      pageSize: 200
    });
    const all = filesRes.data.files;
    const photos  = all.filter(f => f.mimeType && f.mimeType.startsWith('image/'));
    const docFile = all.find(f => f.mimeType === 'application/vnd.google-apps.document');

    let description = null;
    if (docFile) {
      try {
        const exp = await drive.files.export(
          { fileId: docFile.id, mimeType: 'text/plain' },
          { responseType: 'text' }
        );
        description = typeof exp.data === 'string' ? exp.data.trim() : null;
      } catch (_) { /* description optional */ }
    }

    const meta = await drive.files.get({
      fileId: folderId,
      fields: 'id, name, webViewLink',
      supportsAllDrives: true
    });

    res.json({
      folderId,
      folderName: meta.data.name,
      folderLink: meta.data.webViewLink,
      description,
      photos: photos.map(f => ({
        id:      f.id,
        name:    f.name,
        caption: f.description && f.description !== ''
                   ? f.description
                   : f.name.replace(/^\d+_/, '').replace(/\.[^.]+$/, '')
      }))
    });
  } catch (err) {
    console.error('event-detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: POST /api/drive/browse-folder
// Body: { rootName, albumName, folderName }
// Returns: { path, folderId, files: [{ id, name, mimeType, size }] }
// ============================================================
app.post('/api/drive/browse-folder', requireAdmin, async (req, res) => {
  const { rootName, albumName, folderName } = req.body;
  if (!rootName || !albumName || !folderName) {
    return res.status(400).json({ error: 'Missing rootName, albumName, or folderName' });
  }
  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });
    const driveOpts = { includeItemsFromAllDrives: true, supportsAllDrives: true };

    const { destId } = await walkDrivePath(drive, driveOpts, rootName, albumName, folderName);

    // List image files — include description field for captions
    const filesRes = await drive.files.list({
      q: `'${destId}' in parents and mimeType contains 'image/' and trashed = false`,
      fields: 'files(id, name, mimeType, size, description)',
      spaces: 'drive',
      orderBy: 'name',
      pageSize: 200,
      ...driveOpts
    });

    // Fetch folder metadata (description + Drive link) in parallel with file mapping
    const folderMeta = await drive.files.get({
      fileId: destId,
      fields: 'name, description, webViewLink',
      supportsAllDrives: true
    });

    const files = filesRes.data.files.map(f => ({
      id:       f.id,
      name:     f.name,
      caption:  f.description !== undefined && f.description !== null && f.description !== ''
                  ? f.description
                  : f.name.replace(/^\d+_/, '').replace(/\.[^.]+$/, ''),
      mimeType: f.mimeType,
      size:     parseInt(f.size || 0, 10)
    }));

    res.json({
      folderId:          destId,
      folderName:        folderMeta.data.name        || folderName,
      folderDescription: folderMeta.data.description || '',
      folderLink:        folderMeta.data.webViewLink  || '',
      path:              `${rootName} › ${albumName} › ${folderName}`,
      count:             files.length,
      files
    });
  } catch (err) {
    console.error('browse-folder error:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: POST /api/drive/save-captions
// Body: { captions: { [fileId]: "caption text" } }
// Saves each caption as the file's Drive description field.
// ============================================================
app.post('/api/drive/save-captions', requireAdmin, async (req, res) => {
  const { captions } = req.body;
  if (!captions || typeof captions !== 'object') {
    return res.status(400).json({ error: 'Missing captions object' });
  }
  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });
    const driveOpts = { includeItemsFromAllDrives: true, supportsAllDrives: true };

    // Update each file's description in parallel
    await Promise.all(
      Object.entries(captions).map(([fileId, caption]) =>
        drive.files.update({
          fileId,
          requestBody: { description: caption },
          fields: 'id',
          ...driveOpts
        })
      )
    );

    res.json({ ok: true, saved: Object.keys(captions).length });
  } catch (err) {
    console.error('save-captions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: GET /api/drive/thumbnail/:fileId
// Fetches the Drive thumbnail server-side (OAuth) and proxies
// the image data back — avoids CORS / auth issues in <img> tags.
// ============================================================
app.get('/api/drive/thumbnail/:fileId', requireAdmin, async (req, res) => {
  try {
    const client = buildOAuthClient(req.session.tokens);
    const drive = google.drive({ version: 'v3', auth: client });

    // Get the thumbnailLink for this file
    const info = await drive.files.get({
      fileId: req.params.fileId,
      fields: 'thumbnailLink, mimeType',
      supportsAllDrives: true
    });

    if (!info.data.thumbnailLink) {
      return res.status(404).send('No thumbnail available');
    }

    // Fetch thumbnail server-side using the auth client
    const thumbRes = await client.request({
      url: info.data.thumbnailLink,
      responseType: 'arraybuffer'
    });

    const ct = (thumbRes.headers && thumbRes.headers['content-type']) || 'image/jpeg';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'private, max-age=600');
    res.send(Buffer.from(thumbRes.data));
  } catch (err) {
    console.error('Thumbnail proxy error:', err.message);
    res.status(500).send('Error');
  }
});

// ============================================================
// ROUTE: POST /api/drive/create-description  — Test 6
// Body: { folderId, folderName, subject, sender, date, body }
// Creates a Google Doc in the given folder from the email body.
// Returns: { id, name, url }
// ============================================================
app.post('/api/drive/create-description', requireAdmin, async (req, res) => {
  const { folderId, folderName, subject, sender, date, body } = req.body;

  if (!folderId || !folderName) {
    return res.status(400).json({ error: 'Missing folderId or folderName' });
  }

  // Build an HTML document from the email fields
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const htmlContent = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body>
<div style="white-space:pre-wrap;font-family:Arial,sans-serif;line-height:1.5">${escapeHtml(body)}</div>
</body></html>`;

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });

    const fileName = 'description';

    // Step 1 — create an empty Google Doc in the correct folder.
    // Separating metadata creation from content upload ensures the parent
    // folder is set correctly (combined multipart uploads can silently lose parents).
    const stub = await drive.files.create({
      requestBody: {
        name:     fileName,
        mimeType: 'application/vnd.google-apps.document',
        parents:  [folderId]
      },
      fields: 'id, name, webViewLink',
      supportsAllDrives: true
    });

    const docId  = stub.data.id;
    const docUrl = stub.data.webViewLink;

    // Step 2 — upload the HTML body into the empty doc.
    await drive.files.update({
      fileId: docId,
      media: {
        mimeType: 'text/html',
        body:     Readable.from([htmlContent])
      },
      fields: 'id',
      supportsAllDrives: true
    });

    // Share the doc so anyone with the link can edit (non-fatal if it fails)
    try {
      await drive.permissions.create({
        fileId:      docId,
        requestBody: { role: 'writer', type: 'anyone' },
        supportsAllDrives: true
      });
      console.log(`Drive: shared doc "${fileName}" as anyone-with-link writer`);
    } catch (shareErr) {
      console.warn(`Drive: could not share doc (non-fatal): ${shareErr.message}`);
    }

    console.log(`Drive: created description doc "${fileName}" in folder ${folderId}`);
    res.json({
      id:   docId,
      name: fileName,
      url:  docUrl
    });

  } catch (err) {
    console.error('Drive create-description error:', err.message);
    if (err.response) console.error('Drive response:', JSON.stringify(err.response.data));
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: GET /api/drive/doc-content?fileId=xxx
// Exports a Google Doc as plain text and returns its content.
// ============================================================
app.get('/api/drive/doc-content', requireAdmin, async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return res.status(400).json({ error: 'Missing fileId' });

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });

    const exported = await drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'text' }
    );

    res.json({ content: exported.data || '' });
  } catch (err) {
    console.error('Drive doc-content error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: POST /api/drive/copy-attachments  — Test 7
// Body: { folderId, messageId }
// Downloads every attachment from the Gmail message and uploads
// each one into the specified Drive folder.
// Returns: { copied, files: [{ filename, id, url, size }] }
// ============================================================
app.post('/api/drive/copy-attachments', requireAdmin, async (req, res) => {
  const { folderId, messageId } = req.body;

  if (!folderId || !messageId) {
    return res.status(400).json({ error: 'Missing folderId or messageId' });
  }

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });

    const gmail = google.gmail({ version: 'v1', auth: client });
    const drive = google.drive({ version: 'v3', auth: client });

    // Fetch full message to find attachment parts
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });

    // Recursively collect parts that have attachmentIds
    function collectAttachments(parts, acc) {
      if (!parts) return acc;
      for (const part of parts) {
        if (part.filename && part.body && part.body.attachmentId) {
          acc.push({
            filename:     part.filename,
            mimeType:     part.mimeType || 'application/octet-stream',
            attachmentId: part.body.attachmentId,
            size:         part.body.size || 0
          });
        }
        if (part.parts) collectAttachments(part.parts, acc);
      }
      return acc;
    }

    const attachments = collectAttachments(
      msg.data.payload && msg.data.payload.parts,
      []
    );

    if (!attachments.length) {
      return res.json({ copied: 0, files: [], message: 'No attachments found in this email' });
    }

    const results = [];
    const errors  = [];

    for (const att of attachments) {
      try {
        // Download attachment data from Gmail
        const attRes = await gmail.users.messages.attachments.get({
          userId:    'me',
          messageId: messageId,
          id:        att.attachmentId
        });

        // Gmail returns base64url — convert to Buffer
        const b64 = (attRes.data.data || '').replace(/-/g, '+').replace(/_/g, '/');
        const buf = Buffer.from(b64, 'base64');

        // Upload to Drive
        const uploaded = await drive.files.create({
          requestBody: {
            name:        att.filename,
            description: att.filename,
            mimeType:    att.mimeType,
            parents:     [folderId]
          },
          media: {
            mimeType: att.mimeType,
            body:     Readable.from([buf])
          },
          fields: 'id, name, webViewLink',
          supportsAllDrives: true
        });

        console.log(`Drive: uploaded attachment "${att.filename}" to folder ${folderId}`);
        results.push({
          filename: att.filename,
          mimeType: att.mimeType,
          size:     att.size,
          id:       uploaded.data.id,
          url:      uploaded.data.webViewLink
        });
      } catch (attErr) {
        console.error(`Drive: failed to copy "${att.filename}":`, attErr.message);
        errors.push({ filename: att.filename, error: attErr.message });
      }
    }

    res.json({
      copied:  results.length,
      failed:  errors.length,
      files:   results,
      errors:  errors,
      message: `${results.length} attachment(s) copied${errors.length ? `, ${errors.length} failed` : ''}`
    });

  } catch (err) {
    console.error('Drive copy-attachments error:', err.message);
    if (err.response) console.error('Drive response:', JSON.stringify(err.response.data));
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: DELETE /api/drive/trash-file?fileId=...
// Moves a Drive file to the trash (recoverable).
// ============================================================
app.delete('/api/drive/trash-file', requireAdmin, async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return res.status(400).json({ error: 'Missing fileId' });

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });

    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Drive trash-file error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: POST /api/drive/upload-files
// Multipart upload: folderId (field) + files[] (file fields)
// Uploads each file directly to the specified Drive folder.
// ============================================================
app.post('/api/drive/upload-files', requireAdmin, upload.array('files', 50), async (req, res) => {
  const { folderId } = req.body;
  if (!folderId)           return res.status(400).json({ error: 'Missing folderId' });
  if (!req.files || !req.files.length)
                           return res.status(400).json({ error: 'No files received' });

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });

    const results = [];
    const errors  = [];

    for (const file of req.files) {
      try {
        const uploaded = await drive.files.create({
          requestBody: {
            name:        file.originalname,
            description: file.originalname,
            mimeType:    file.mimetype || 'application/octet-stream',
            parents:     [folderId]
          },
          media: {
            mimeType: file.mimetype || 'application/octet-stream',
            body:     Readable.from([file.buffer])
          },
          fields: 'id, name, webViewLink',
          supportsAllDrives: true
        });

        results.push({
          filename: file.originalname,
          mimeType: file.mimetype,
          size:     file.size,
          id:       uploaded.data.id,
          url:      uploaded.data.webViewLink
        });
      } catch (fileErr) {
        console.error(`Drive: failed to upload "${file.originalname}":`, fileErr.message);
        errors.push({ filename: file.originalname, error: fileErr.message });
      }
    }

    res.json({
      uploaded: results.length,
      failed:   errors.length,
      files:    results,
      errors:   errors,
      message:  `${results.length} file(s) uploaded${errors.length ? `, ${errors.length} failed` : ''}`
    });

  } catch (err) {
    console.error('Drive upload-files error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: GET /api/drive/debug-folders?root=Council+Activities
// Returns every folder found with that name plus their direct
// subfolder children — for diagnosing path mismatches.
// ============================================================
app.get('/api/drive/debug-folders', requireAdmin, async (req, res) => {
  const rootName = (req.query.root || 'Council Activities').trim();
  const esc = str => str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });

    // Find ALL folders with this name anywhere in Drive
    const rootRes = await drive.files.list({
      q: `name = '${esc(rootName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name, parents, driveId)',
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });

    const roots = rootRes.data.files;

    // For each root found, list its direct subfolder children
    const results = await Promise.all(roots.map(async root => {
      const childRes = await drive.files.list({
        q: `'${root.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        spaces: 'drive',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        pageSize: 50
      });
      return {
        id:       root.id,
        name:     root.name,
        parents:  root.parents || [],
        driveId:  root.driveId || null,
        children: childRes.data.files.map(f => ({ id: f.id, name: f.name }))
      };
    }));

    res.json({ rootName, roots: results });
  } catch (err) {
    console.error('Debug Drive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: POST /api/drive/create-folder  — Test 5
// ============================================================
// Body: { rootName, albumName, folderName }
// 1. Finds rootName folder in Drive
// 2. Finds albumName inside root
// 3. Creates folderName inside album (or reports if it already exists)
// Returns: { created, id, name, url, path, message }
// ============================================================
app.post('/api/drive/create-folder', requireAdmin, async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'No Drive token. Please sign out and sign back in.' });
  }

  const { rootName, albumName, folderName } = req.body;

  if (!rootName || !albumName || !folderName) {
    return res.status(400).json({ error: 'Missing required: rootName, albumName, folderName' });
  }

  // Escape single quotes for Drive search queries
  const esc = str => str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });

    const drive = google.drive({ version: 'v3', auth: client });

    const driveOpts = { includeItemsFromAllDrives: true, supportsAllDrives: true };

    // Walk the path exactly: My Drive root → rootName → albumName
    // Listing children rather than text-searching avoids index/duplicate issues.

    // Step 1 — list all top-level folders in My Drive, find rootName
    const step1 = await drive.files.list({
      q: `'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
      pageSize: 100,
      ...driveOpts
    });

    const rootFolder = step1.data.files.find(f => f.name === rootName);
    if (!rootFolder) {
      const topLevel = step1.data.files.map(f => `"${f.name}"`).join(', ') || '(none)';
      return res.status(404).json({
        error: `"${rootName}" not found at My Drive root. Top-level folders: ${topLevel}`
      });
    }
    console.log(`Drive: found root "${rootName}" id=${rootFolder.id}`);

    // Step 2 — list subfolders of rootFolder, find albumName
    const step2 = await drive.files.list({
      q: `'${rootFolder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
      pageSize: 100,
      ...driveOpts
    });

    const albumFolder = step2.data.files.find(f => f.name === albumName);
    if (!albumFolder) {
      const subs = step2.data.files.map(f => `"${f.name}"`).join(', ') || '(none)';
      return res.status(404).json({
        error: `"${albumName}" not found inside "${rootName}". Subfolders found: ${subs}`
      });
    }
    const albumId = albumFolder.id;
    console.log(`Drive: found album "${albumName}" id=${albumId}`);

    // Step 3 — check if destination folder already exists
    const destRes = await drive.files.list({
      q: `name = '${esc(folderName)}' and mimeType = 'application/vnd.google-apps.folder' and '${albumId}' in parents and trashed = false`,
      fields: 'files(id, name, webViewLink)',
      spaces: 'drive',
      ...driveOpts
    });

    if (destRes.data.files.length) {
      const existing = destRes.data.files[0];
      console.log(`Drive: folder already exists — "${folderName}"`);
      return res.json({
        created: false,
        id:      existing.id,
        name:    existing.name,
        url:     existing.webViewLink,
        path:    `${rootName} › ${albumName} › ${existing.name}`,
        message: 'Folder already exists'
      });
    }

    // Step 4 — create the destination folder
    const created = await drive.files.create({
      requestBody: {
        name:     folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents:  [albumId]
      },
      fields: 'id, name, webViewLink',
      ...driveOpts
    });

    console.log(`Drive: created folder "${folderName}" inside "${albumName}"`);
    res.json({
      created: true,
      id:      created.data.id,
      name:    created.data.name,
      url:     created.data.webViewLink,
      path:    `${rootName} › ${albumName} › ${created.data.name}`,
      message: 'Folder created successfully'
    });

  } catch (err) {
    console.error('Drive API error:', err.message);
    if (err.response) console.error('Drive response:', JSON.stringify(err.response.data));
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: GET /api/drive/get-description?folderId=...
// Finds the Description Google Doc in the folder and returns its text.
// Returns: { fileId, fileName, content }  (or content: '' if not found)
// ============================================================
app.get('/api/drive/get-description', requireAdmin, async (req, res) => {
  const { folderId } = req.query;
  if (!folderId) return res.status(400).json({ error: 'Missing folderId' });

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });
    const driveOpts = { includeItemsFromAllDrives: true, supportsAllDrives: true };

    // Look for a Google Doc in the folder (the description doc created by the pipeline)
    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.document' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
      orderBy: 'name',
      pageSize: 10,
      ...driveOpts
    });

    const files = listRes.data.files || [];
    if (!files.length) {
      return res.json({ fileId: null, fileName: null, content: '' });
    }

    // Prefer a file whose name starts with "Description", otherwise take the first doc
    const doc = files.find(f => f.name.toLowerCase().startsWith('description')) || files[0];

    // Export the Google Doc as plain text
    const exported = await drive.files.export({
      fileId: doc.id,
      mimeType: 'text/plain'
    }, { responseType: 'text' });

    const content = (exported.data || '').replace(/\r\n/g, '\n').trim();
    const docUrl = `https://docs.google.com/document/d/${doc.id}/edit`;
    res.json({ fileId: doc.id, fileName: doc.name, content, docUrl });

  } catch (err) {
    console.error('get-description error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: POST /api/drive/save-description
// Body: { fileId, content }
// Overwrites the Google Doc content with the provided plain text.
// ============================================================
app.post('/api/drive/save-description', requireAdmin, async (req, res) => {
  const { fileId, content } = req.body;
  if (!fileId) return res.status(400).json({ error: 'Missing fileId' });

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });

    // Re-upload as HTML so it converts cleanly into the existing Google Doc
    const htmlContent = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body><div style="white-space:pre-wrap;font-family:Arial,sans-serif;line-height:1.5">${
  String(content || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}</div></body></html>`;

    await drive.files.update({
      fileId,
      media: {
        mimeType: 'text/html',
        body: Readable.from([htmlContent])
      },
      fields: 'id',
      supportsAllDrives: true
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('save-description error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: POST /api/drive/reorder-files
// Body: { files: [{ id, name }, ...] } in desired display order.
// Renames each file with a zero-padded numeric prefix: 01_, 02_, …
// ============================================================
app.post('/api/drive/reorder-files', requireAdmin, async (req, res) => {
  const { files } = req.body;
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Missing or empty files array' });
  }

  try {
    const client = buildOAuthClient(req.session.tokens);
    client.on('tokens', t => { req.session.tokens = { ...req.session.tokens, ...t }; });
    const drive = google.drive({ version: 'v3', auth: client });

    const results = await Promise.all(files.map((file, i) => {
      const baseName = file.name.replace(/^\d+_/, '');
      const newName  = String(i + 1).padStart(2, '0') + '_' + baseName;
      const requestBody = { name: newName };
      if (file.description !== undefined && file.description !== '') {
        requestBody.description = file.description;
      }
      return drive.files.update({
        fileId: file.id,
        requestBody,
        fields: 'id,name',
        supportsAllDrives: true
      }).then(r => ({ id: r.data.id, name: r.data.name }));
    }));

    res.json({ ok: true, files: results });
  } catch (err) {
    console.error('reorder-files error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE: GET /logout
// ============================================================
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ============================================================
// CATCH-ALL: return JSON 404 for unmatched /api/* routes so
// the browser never receives an HTML error page for API calls.
// ============================================================
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `No route: ${req.method} ${req.path}` });
  }
  next();
});

// ============================================================
// TEMPORARY — download source as zip (requires sign-in)
// ============================================================
app.get('/download-source', (req, res) => {
  const { exec } = require('child_process');
  const zipPath = '/tmp/koc-blog-source.zip';
  const srcDir  = path.join(__dirname, '..');
  // Zip the koc-blog folder, excluding node_modules
  const cmd = `cd "${srcDir}" && zip -r "${zipPath}" artifacts/koc-blog -x "*/node_modules/*"`;
  exec(cmd, (err) => {
    if (err) return res.status(500).send('Could not create zip: ' + err.message);
    res.download(zipPath, 'koc-blog-source.zip');
  });
});

// ============================================================
// SPA FALLBACK — serve index.html for client-side navigation routes
// ============================================================
app.get(['/email', '/manual', '/posts'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// GLOBAL EXPRESS ERROR HANDLER — always returns JSON for /api/*
// ============================================================
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Unhandled error:', err.message);
  if (req.path.startsWith('/api/')) {
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
  res.status(500).send('Internal server error');
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`KofC Blog Admin running on port ${PORT}`);
});
