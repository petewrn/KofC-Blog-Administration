// ============================================================
// script.js — KofC Blog Admin
// ============================================================

// ---- STATE ----
const S = {
  // Email pipeline
  emails:         [],
  selectedEmail:  null,   // { id, date, from, subject, attachmentCount }
  emailDetail:    null,   // full detail from /api/gmail/message/:id
  currentStep:    1,
  mode:           'email',  // 'email' | 'manual'
  albumName:      '2026 Album',
  folderName:     '',
  folderId:       null,
  folderUrl:      null,
  descDocId:      null,
  descDocUrl:     null,
  descBody:       '',
  copiedFiles:      [],
  pendingUploads:   [],   // File objects queued for upload (email mode drop zone)
  arrangedFiles:    [],   // ordered list for Arrange Photos step
  captions:         {},   // fileId → caption string
  selectedPhotoIdx: null, // currently selected tile in Step 5
  // Manual entry photo picker
  candidateFiles:      [],      // File objects from directory picker
  selectedCandidates:  new Set(), // indices of selected candidates
  candidateObjectUrls: {},      // index → object URL for revocation
  failedUploadFiles:   [],      // File objects that failed upload (for retry)
};

// ---- FEATURE DETECTION ----
const supportsDirectoryPicker = typeof window.showDirectoryPicker === 'function';

// ---- CLIENT-SIDE ROUTING ----
const ROUTE_TO_MODE = { '/email': 'email', '/manual': 'manual', '/posts': 'view' };
const MODE_TO_ROUTE = { email: '/email', manual: '/manual', view: '/posts' };
const SECTION_CONTENT = {
  email:  { title: 'Create a Blog Post from Email',  desc: 'Select a submitted email, review its contents, and create the blog post.' },
  manual: { title: 'Create a Blog Post Manually',    desc: 'Enter the activity information and select photos from your device.' },
  view:   { title: 'Manage Blog Posts',              desc: 'View, review, and manage existing blog posts.' },
};

// ---- INIT ----
async function init() {
  let data;
  try {
    data = await api('GET', '/api/me');
  } catch (e) {
    hide('screen-loading');
    show('screen-login');
    return;
  }

  hide('screen-loading');

  if (!data.loggedIn || !data.isAdmin) {
    show('screen-login');
    if (data.denied) {
      const el = document.getElementById('login-denied');
      el.textContent = `Access denied for ${data.denied}. Only the council admin account may log in.`;
      el.hidden = false;
    }
    return;
  }

  show('screen-app');
  document.getElementById('navbar-email').textContent = data.user.email;

  initDropZone();
  initPhotoInput();
  initFolderPickerUI();

  // Detect initial section from URL, normalise to correct path, then apply
  const initMode = ROUTE_TO_MODE[window.location.pathname] || 'email';
  history.replaceState({ mode: initMode }, '', MODE_TO_ROUTE[initMode]);
  switchMode(initMode, { updateHistory: false });
  loadInbox();
}

// ---- VIEW STATE (Archive tab) ----
const V = {
  photos:      [],
  carouselIdx: 0,
};

// ---- MODE SWITCHING ----
function switchMode(mode, opts = {}) {
  const pushHistory = opts.updateHistory !== false;
  const newPath = MODE_TO_ROUTE[mode] || '/email';
  if (pushHistory && window.location.pathname !== newPath) {
    history.pushState({ mode }, '', newPath);
  }

  S.mode = mode;

  // Update nav active state + aria-current
  ['email', 'manual', 'view'].forEach(m => {
    const btn = document.getElementById(`tab-btn-${m === 'view' ? 'view' : m}`);
    if (!btn) return;
    const isActive = m === mode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  // Update section heading
  const content = SECTION_CONTENT[mode] || SECTION_CONTENT.email;
  const titleEl = document.getElementById('section-title');
  const descEl  = document.getElementById('section-desc');
  if (titleEl) titleEl.textContent = content.title;
  if (descEl)  descEl.textContent  = content.desc;

  // Show / hide main panels
  const emailPanel = document.getElementById('tab-email');
  const viewPanel  = document.getElementById('tab-view');
  emailPanel.hidden = (mode === 'view');
  viewPanel.hidden  = (mode !== 'view');

  if (mode === 'view') {
    loadArchive();
    return;
  }

  if (mode === 'manual') {
    _resetState();
    const yr = new Date().getFullYear();
    document.getElementById('step2-album-input').value = yr + ' Album';
    document.getElementById('step2-folder-input').value = '';
    document.getElementById('step2-email-section').hidden = true;
    _resetStep2UI();
    _resetStep3UI();
    _resetStep4UI();
    S.currentStep = 2;
    updateStepUI();
  } else {
    // Email mode
    _resetState();
    document.getElementById('step2-email-section').hidden = false;
    _resetStep2UI();
    _resetStep3UI();
    _resetStep4UI();
    document.getElementById('btn-process-email').disabled = true;
    S.currentStep = 1;
    updateStepUI();
    renderInbox();
  }
}

// Handle browser Back / Forward buttons
window.addEventListener('popstate', (e) => {
  const mode = (e.state && e.state.mode) || ROUTE_TO_MODE[window.location.pathname] || 'email';
  switchMode(mode, { updateHistory: false });
});

// ============================================================
// EMAIL PIPELINE
// ============================================================

async function loadInbox() {
  document.getElementById('inbox-loading').textContent = 'Loading emails…';
  document.getElementById('inbox-loading').hidden = false;
  hide('inbox-table');
  hide('inbox-error');

  try {
    const chk = document.getElementById('chk-submissions-only');
    const submissionsOnly = !chk || chk.checked;
    const data = await api('GET', `/api/gmail/recent${submissionsOnly ? '' : '?all=true'}`);
    document.getElementById('inbox-loading').hidden = true;

    if (!data.emails || data.emails.length === 0) {
      document.getElementById('inbox-loading').textContent = 'No emails with "blog" in the subject found.';
      document.getElementById('inbox-loading').hidden = false;
      return;
    }

    S.emails = data.emails;
    renderInbox();
    show('inbox-table');
  } catch (err) {
    hide('inbox-loading');
    showError('inbox-error', err.message);
  }
}

function renderInbox() {
  const tbody = document.getElementById('inbox-tbody');
  tbody.innerHTML = '';
  S.emails.forEach(email => {
    const tr = document.createElement('tr');
    tr.dataset.id = email.id;
    if (S.selectedEmail && S.selectedEmail.id === email.id) tr.classList.add('selected');

    const date = formatDate(email.date);
    const from = email.sender ? shortenEmail(email.sender) : '';

    tr.innerHTML = `
      <td class="td-date">${esc(date)}</td>
      <td class="td-from">${esc(from)}</td>
      <td class="td-subject">${esc(email.subject)}</td>
      <td class="td-attach">📎 ${email.attachmentCount || 0}</td>
    `;
    tr.addEventListener('click', () => selectEmail(email));
    tbody.appendChild(tr);
  });
}

function selectEmail(email) {
  S.selectedEmail = email;
  renderInbox();
  document.getElementById('btn-process-email').disabled = false;
}

async function goToStep(n) {
  // Apply 'blog---published' Gmail label when finishing a post (email mode, fire-and-forget)
  if (n === 6 && S.mode === 'email' && S.selectedEmail) {
    api('POST', '/api/gmail/apply-label', { messageId: S.selectedEmail.id }).catch(() => {});
  }

  // Load email detail when moving from step 1 → 2 in email mode
  if (n === 2 && S.mode === 'email' && !S.emailDetail) {
    try {
      S.emailDetail = await api('GET', `/api/gmail/message/${S.selectedEmail.id}`);
    } catch (err) {
      alert('Failed to load email detail: ' + err.message);
      return;
    }
    // Pre-fill album year and YYYY_MM_DD prefix from email date
    const d = new Date(S.emailDetail.date);
    let prefix = '';
    if (!isNaN(d.getTime())) {
      const yr = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      prefix = `${yr}_${mo}_${dd} `;
      document.getElementById('step2-album-input').value = yr + ' Album';
    }

    // Pre-fill folder name: YYYY_MM_DD + clean event name (no double date)
    const suggestion = S.emailDetail.folderSuggestion;
    const eventName  = suggestion ? (suggestion.nameOnly || suggestion.primary) : '';
    document.getElementById('step2-folder-input').value = prefix + eventName;

    // Populate email summary
    const sum = document.getElementById('step2-email-summary');
    sum.innerHTML = `
      <p><span class="lbl">Subject: </span><span class="val">${esc(S.emailDetail.subject)}</span></p>
      <p><span class="lbl">From: </span><span class="val">${esc(S.emailDetail.from)}</span></p>
      <p><span class="lbl">Date: </span><span class="val">${esc(S.emailDetail.date)}</span></p>
      <p><span class="lbl">Attachments: </span><span class="val">${S.emailDetail.attachments.length}</span></p>
    `;

    // Pre-fill body textarea
    S.descBody = S.emailDetail.body ? S.emailDetail.body.slice(0, 2000) : '';
    document.getElementById('step3-body-preview').value = S.descBody;

    // Build email attachments list for step 4
    renderAttachList(false);
  }

  // Show/hide email summary on step 2
  if (n === 2) {
    document.getElementById('step2-email-section').hidden = (S.mode === 'manual');
  }

  // Adjust step 4 for current mode
  if (n === 4) {
    updateStep4Mode();
  }

  // Initialize gallery when entering Arrange Photos
  if (n === 5) {
    // Merge any new files added since last time
    const existingIds = new Set(S.arrangedFiles.map(f => f.id));
    const newFiles = S.copiedFiles.filter(f => !existingIds.has(f.id));
    S.arrangedFiles = [...S.arrangedFiles, ...newFiles];
    hide('step5-success');
    hide('step5-error');
    const confirmBtn = document.getElementById('btn-confirm-order');
    confirmBtn.disabled = false;
    confirmBtn.textContent = '✓ Confirm Order →';
    renderGallery();
  }

  // Rebuild summary when entering Finish Post
  if (n === 6) {
    buildDoneSummary();
  }

  S.currentStep = n;
  updateStepUI();
}

function updateStepUI() {
  // In manual mode, hide "Select Email" step indicator and its following arrow
  const isManual = S.mode === 'manual';
  const ind1   = document.getElementById('step-ind-1');
  const arrow1 = document.getElementById('step-arrow-1');
  if (ind1)   ind1.hidden   = isManual;
  if (arrow1) arrow1.hidden = isManual;

  for (let i = 1; i <= 6; i++) {
    const panel = document.getElementById(`step-${i}`);
    const ind   = document.getElementById(`step-ind-${i}`);
    if (panel) panel.hidden = (i !== S.currentStep);
    if (ind && !ind.hidden) {
      ind.className = 'step-item';
      if (i < S.currentStep) ind.classList.add('done');
      if (i === S.currentStep) ind.classList.add('active');
    }
  }
}

async function createFolder() {
  const folderName = document.getElementById('step2-folder-input').value.trim();
  const albumName  = document.getElementById('step2-album-input').value.trim();
  if (!folderName) { alert('Please enter a folder name.'); return; }

  S.folderName = folderName;
  S.albumName  = albumName;

  const btn = document.getElementById('btn-create-folder');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  hide('step2-error');
  hide('step2-success');

  try {
    const data = await api('POST', '/api/drive/create-folder', {
      rootName:   'Council Activities',
      albumName,
      folderName
    });

    S.folderId  = data.id;
    S.folderUrl = data.url;

    const msg = data.created ? 'Folder created successfully in Google Drive' : 'Folder already exists — will use it';
    showSuccess('step2-success', msg);
    btn.hidden = true;
    show('btn-to-step3');
  } catch (err) {
    showError('step2-error', err.message);
    btn.disabled = false;
    btn.textContent = '📁 Create Folder';
  }
}

async function createDescDoc() {
  if (!S.folderId) return;

  const btn = document.getElementById('btn-create-desc');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  hide('step3-error');
  hide('step3-success');

  // Read from the editable textarea
  S.descBody = document.getElementById('step3-body-preview').value;

  try {
    const data = await api('POST', '/api/drive/create-description', {
      folderId:   S.folderId,
      folderName: S.folderName,
      subject:    S.emailDetail ? S.emailDetail.subject : S.folderName,
      sender:     S.emailDetail ? S.emailDetail.from    : '',
      date:       S.emailDetail ? S.emailDetail.date    : new Date().toDateString(),
      body:       S.descBody
    });

    S.descDocId  = data.id;
    S.descDocUrl = data.url;

    // Show "Edit with Google Doc" link
    const docsLink = document.getElementById('btn-step3-edit-docs');
    docsLink.href   = S.descDocUrl;
    docsLink.hidden = false;

    showSuccess('step3-success', `Description saved: "${data.name}"`);
    btn.hidden = true;
    show('btn-to-step4');
  } catch (err) {
    showError('step3-error', err.message);
    btn.disabled = false;
    btn.textContent = '💾 Save Activity Description';
  }
}

function renderAttachList(done) {
  const list = document.getElementById('step4-attach-list');
  list.innerHTML = '';
  const attachments = S.emailDetail ? S.emailDetail.attachments : [];

  if (attachments.length === 0) {
    list.innerHTML = '<p style="color:#6b7280;font-size:13px">No attachments found in this email.</p>';
    return;
  }

  attachments.forEach(att => {
    const div = document.createElement('div');
    div.className = 'attach-row' + (done ? ' done' : '');
    div.innerHTML = `
      <span class="attach-name">📎 ${esc(att.filename)} <span style="color:#9ca3af;font-size:11px">${formatSize(att.size)}</span></span>
      ${done ? '<span class="check-icon">✓</span>' : ''}
    `;
    list.appendChild(div);
  });
}

async function copyAttachments() {
  if (!S.folderId || !S.emailDetail) return;

  const btn = document.getElementById('btn-copy-attaches');
  btn.disabled = true;
  btn.textContent = 'Copying…';

  hide('step4-error');
  hide('step4-success');

  try {
    const data = await api('POST', '/api/drive/copy-attachments', {
      folderId:  S.folderId,
      messageId: S.selectedEmail.id
    });

    // Normalize driveId → id for consistency
    S.copiedFiles = (data.files || []).map(f => ({ ...f, id: f.driveId || f.id }));
    renderAttachList(true);

    const msg = data.failed
      ? `${data.copied} attachment(s) copied, ${data.failed} failed`
      : `${data.copied} attachment(s) copied to Drive`;

    if (data.failed) {
      showError('step4-error', msg);
    } else {
      showSuccess('step4-success', msg);
    }

    btn.hidden = true;
    show('btn-to-step5');
  } catch (err) {
    showError('step4-error', err.message);
    btn.disabled = false;
    btn.textContent = '📎 Copy Email Attachments to Drive';
  }
}

// ============================================================
// STEP 4 — MODE + UPLOAD HELPERS
// ============================================================

function updateStep4Mode() {
  const isManual = S.mode === 'manual';

  // Email-mode elements
  document.getElementById('step4-email-section').hidden  = isManual;
  document.getElementById('btn-copy-attaches').hidden    = isManual;
  document.getElementById('btn-upload-files').hidden     = isManual;
  document.getElementById('step4-drop-zone').hidden      = isManual;
  document.getElementById('step4-add-more').hidden       = true;
  document.getElementById('step4-selected-label').hidden = isManual;
  document.getElementById('step4-pending-list').hidden   = isManual;

  // Manual-mode elements
  document.getElementById('step4-folder-picker').hidden = !isManual;
  document.getElementById('btn-next-arrange').hidden    = !isManual;

  // Card subtitle
  const sub = document.getElementById('step4-card-sub');
  if (sub) sub.textContent = isManual
    ? 'Open your event photo folder and choose which photos to include.'
    : 'Copy email attachments or upload photos directly to the Drive folder';
}

function initDropZone() {
  const zone  = document.getElementById('step4-drop-zone');
  const input = document.getElementById('step4-file-input');

  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    addPendingFiles(e.dataTransfer.files);
    collapseDropZone();
  });
  zone.addEventListener('click', e => {
    if (e.target.tagName !== 'LABEL') input.click();
  });
  input.addEventListener('change', () => {
    addPendingFiles(input.files);
    input.value = '';
    if (S.pendingUploads.length > 0) collapseDropZone();
  });
}

function collapseDropZone() {
  hide('step4-drop-zone');
  show('step4-add-more');
}

function expandDropZone() {
  show('step4-drop-zone');
  hide('step4-add-more');
}

function addPendingFiles(fileList) {
  Array.from(fileList).forEach(f => {
    const dupe = S.pendingUploads.find(p => p.name === f.name && p.size === f.size);
    if (!dupe) S.pendingUploads.push(f);
  });
  renderPendingList();
}

function renderPendingList() {
  const list = document.getElementById('step4-pending-list');
  list.innerHTML = '';

  // Update count badge
  const countEl = document.getElementById('step4-pending-count');
  if (countEl) countEl.textContent = S.pendingUploads.length > 0 ? `(${S.pendingUploads.length})` : '';

  // Enable upload button only when files are queued
  const uploadBtn = document.getElementById('btn-upload-files');
  if (uploadBtn) uploadBtn.disabled = (S.pendingUploads.length === 0);

  if (S.pendingUploads.length === 0) return;

  S.pendingUploads.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'attach-row';
    div.innerHTML = `
      <span class="attach-name">📷 ${esc(f.name)} <span style="color:#9ca3af;font-size:11px">${formatSize(f.size)}</span></span>
      <button class="btn-remove-file" onclick="removePendingFile(${i})" title="Remove">✕</button>
    `;
    list.appendChild(div);
  });
}

function removePendingFile(i) {
  S.pendingUploads.splice(i, 1);
  renderPendingList();
}

// ============================================================
// MANUAL ENTRY — FOLDER PICKER & PHOTO SELECTION
// ============================================================

// Called once at app start — wires up the hidden photoInput change handler
function initPhotoInput() {
  const input = document.getElementById('photoInput');
  if (!input) return;
  input.addEventListener('change', function () {
    if (this.files && this.files.length > 0) {
      processSelectedPhotos(Array.from(this.files));
    }
    this.value = ''; // Reset so the same file can be picked again
  });
}

// Called once at app start — shows/hides controls based on browser capability
function initFolderPickerUI() {
  const folderOption = document.getElementById('step4-folder-option');
  const fileBtn      = document.getElementById('btn-select-photos');
  const fileHint     = document.getElementById('step4-file-hint');

  if (supportsDirectoryPicker) {
    if (folderOption) folderOption.hidden = false;
    if (fileBtn)  fileBtn.textContent  = '📷 Select Individual Photos…';
    if (fileHint) fileHint.textContent = 'Choose particular photos directly from your computer.';
  }
  // When not supported: folder option stays hidden; "Select Photos…" is already the default label
}

// Shared processing function — called by both openEventFolder() and selectIndividualPhotos()
function processSelectedPhotos(files) {
  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);
  const valid = files.filter(f => IMAGE_EXTS.has(f.name.split('.').pop().toLowerCase()));

  // Deduplicate: name + size + lastModified
  const key = f => `${f.name}|${f.size}|${f.lastModified}`;
  const existing = new Set(S.candidateFiles.map(key));
  const added = valid.filter(f => !existing.has(key(f)));

  if (added.length === 0) return;

  S.candidateFiles.push(...added);
  S.candidateFiles.sort((a, b) => a.name.localeCompare(b.name));

  // Rebuild object URLs since indices may have shifted after sort
  _revokeCandidateUrls();

  const nameEl = document.getElementById('step4-folder-name');
  if (nameEl) {
    nameEl.textContent = `${S.candidateFiles.length} image${S.candidateFiles.length !== 1 ? 's' : ''} available`;
    nameEl.style.display = 'block';
  }

  renderPhotoPickerGrid();
  show('step4-photo-picker');
}

function selectIndividualPhotos() {
  const input = document.getElementById('photoInput');
  if (input) input.click();
}

async function openEventFolder() {
  if (!supportsDirectoryPicker) return;
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });

    // Opening a folder starts fresh — clear existing candidates
    _revokeCandidateUrls();
    S.candidateFiles     = [];
    S.selectedCandidates = new Set();

    const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);
    const entries = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind !== 'file') continue;
      if (IMAGE_EXTS.has(entry.name.split('.').pop().toLowerCase())) entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const files = [];
    for (const entry of entries) files.push(await entry.getFile());

    const nameEl = document.getElementById('step4-folder-name');
    if (nameEl) {
      nameEl.textContent = `"${dirHandle.name}" — ${files.length} image${files.length !== 1 ? 's' : ''} found`;
      nameEl.style.display = 'block';
    }

    // processSelectedPhotos handles dedup, sort, grid render (folder already filtered + sorted above)
    processSelectedPhotos(files);
  } catch (err) {
    if (err.name !== 'AbortError') alert('Could not open folder: ' + err.message);
  }
}

function _revokeCandidateUrls() {
  Object.values(S.candidateObjectUrls || {}).forEach(url => URL.revokeObjectURL(url));
  S.candidateObjectUrls = {};
}

function renderPhotoPickerGrid() {
  const grid = document.getElementById('photo-picker-grid');
  grid.innerHTML = '';

  S.candidateFiles.forEach((file, i) => {
    if (!S.candidateObjectUrls[i]) {
      S.candidateObjectUrls[i] = URL.createObjectURL(file);
    }
    const isSelected = S.selectedCandidates.has(i);
    const thumb = document.createElement('div');
    thumb.className   = `picker-thumb ${isSelected ? 'selected' : 'unselected'}`;
    thumb.dataset.idx = i;
    thumb.title       = file.name;
    thumb.addEventListener('click', () => toggleCandidatePhoto(i));

    const img = document.createElement('img');
    img.src     = S.candidateObjectUrls[i];
    img.alt     = file.name;
    img.loading = 'lazy';

    const check = document.createElement('div');
    check.className   = 'picker-thumb-check';
    check.textContent = '✓';

    const name = document.createElement('div');
    name.className   = 'picker-thumb-name';
    name.textContent = file.name;

    thumb.appendChild(img);
    thumb.appendChild(check);
    thumb.appendChild(name);
    grid.appendChild(thumb);
  });

  updatePhotoPickerCount();
}

function toggleCandidatePhoto(i) {
  if (S.selectedCandidates.has(i)) {
    S.selectedCandidates.delete(i);
  } else {
    S.selectedCandidates.add(i);
  }
  const grid = document.getElementById('photo-picker-grid');
  const tile = grid.querySelector(`[data-idx="${i}"]`);
  if (tile) tile.className = `picker-thumb ${S.selectedCandidates.has(i) ? 'selected' : 'unselected'}`;
  updatePhotoPickerCount();
}

function selectAllPhotos() {
  S.candidateFiles.forEach((_, i) => S.selectedCandidates.add(i));
  renderPhotoPickerGrid();
}

function clearPhotoSelection() {
  S.selectedCandidates.clear();
  renderPhotoPickerGrid();
}

function updatePhotoPickerCount() {
  const sel   = S.selectedCandidates.size;
  const total = S.candidateFiles.length;
  const el = document.getElementById('photo-picker-count');
  if (el) el.textContent = `${sel} of ${total} photos selected`;
  const btn = document.getElementById('btn-next-arrange');
  if (btn) btn.disabled = (sel === 0);
}

async function uploadSelectedPhotos() {
  if (!S.folderId) { alert('Create a Drive folder first (Step 2).'); return; }
  if (S.selectedCandidates.size === 0) { alert('Select at least one photo first.'); return; }

  const selectedFiles = [...S.selectedCandidates]
    .sort((a, b) => a - b)
    .map(i => S.candidateFiles[i]);

  S.pendingUploads    = selectedFiles;
  S.failedUploadFiles = [];

  await runUploadWithProgress(selectedFiles);
}

async function runUploadWithProgress(files) {
  if (!files.length) return;
  const total = files.length;

  // Reset and show overlay
  document.getElementById('upload-overlay-title').textContent = 'Uploading Blog Photos';
  document.getElementById('upload-progress-fill').style.width = '0%';
  document.getElementById('upload-progress-count').textContent = `0 of ${total} photos uploaded`;
  document.getElementById('upload-progress-filename-val').textContent = '—';
  document.getElementById('upload-progress-wrap').hidden  = false;
  document.getElementById('upload-complete-section').hidden = true;
  document.getElementById('step4-upload-overlay').hidden = false;

  let uploaded = 0;
  const failedFiles = [];

  for (let i = 0; i < files.length; i++) {
    document.getElementById('upload-progress-filename-val').textContent = files[i].name;
    document.getElementById('upload-progress-count').textContent = `${uploaded} of ${total} photos uploaded`;

    const formData = new FormData();
    formData.append('folderId', S.folderId);
    formData.append('files', files[i]);

    try {
      const res  = await fetch('/api/drive/upload-files', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      uploaded++;
      S.copiedFiles.push(...(data.files || []));
    } catch (err) {
      failedFiles.push(files[i]);
      console.error(`Upload failed for "${files[i].name}":`, err.message);
    }

    const pct = Math.round(((i + 1) / total) * 100);
    document.getElementById('upload-progress-fill').style.width = pct + '%';
    document.getElementById('upload-progress-count').textContent = `${uploaded} of ${total} photos uploaded`;
  }

  S.failedUploadFiles = failedFiles;

  // Show completion
  document.getElementById('upload-progress-filename-val').textContent = '—';
  document.getElementById('upload-progress-wrap').hidden = true;

  const titleEl   = document.getElementById('upload-overlay-title');
  const msgEl     = document.getElementById('upload-complete-msg');
  const retryWrap = document.getElementById('upload-retry-section');

  if (failedFiles.length === 0) {
    titleEl.textContent = 'Upload Complete';
    msgEl.textContent = `${uploaded} photo${uploaded !== 1 ? 's' : ''} uploaded successfully.`;
    retryWrap.hidden = true;
  } else {
    titleEl.textContent = `Upload Completed with Errors`;
    msgEl.textContent = `${uploaded} photo${uploaded !== 1 ? 's' : ''} uploaded successfully.`;
    document.getElementById('upload-retry-list').textContent =
      `${failedFiles.length} photo${failedFiles.length !== 1 ? 's' : ''} failed: ${failedFiles.map(f => f.name).join(', ')}`;
    retryWrap.hidden = false;
  }
  document.getElementById('upload-complete-section').hidden = false;
}

async function retryFailedUploads() {
  const toRetry = [...S.failedUploadFiles];
  if (!toRetry.length) return;
  S.failedUploadFiles = [];
  document.getElementById('upload-retry-section').hidden = true;
  document.getElementById('upload-complete-section').hidden = true;
  document.getElementById('upload-progress-wrap').hidden = false;
  document.getElementById('upload-overlay-title').textContent = 'Retrying Failed Photos';
  document.getElementById('upload-progress-fill').style.width = '0%';
  document.getElementById('upload-progress-count').textContent = `0 of ${toRetry.length} photos uploaded`;
  await runUploadWithProgress(toRetry);
}

function finishUpload() {
  hide('step4-upload-overlay');
  S.selectedCandidates.clear();
  _revokeCandidateUrls();
  goToStep(5);
}

// ============================================================
// MANUAL ENTRY — CAPTION GRID (Step 4, shown after upload)
// ============================================================

function showStep4CaptionGrid() {
  const allFiles = S.copiedFiles.map(f => ({
    id:   f.id,
    name: f.filename || f.name || f.id
  }));

  S.browseFolderId = S.folderId;
  S.browseFiles    = allFiles;
  allFiles.forEach(f => {
    if (!(f.id in S.captions)) {
      S.captions[f.id] = (f.name || '').replace(/^\d+_/, '').replace(/\.[^.]+$/, '');
    }
  });
  S.captionsDirty = false;

  document.getElementById('step4-count-label').textContent =
    `${allFiles.length} photo${allFiles.length !== 1 ? 's' : ''} — click caption to edit`;

  renderStep4CaptionGrid();
  show('step4-caption-section');

  const btn = document.getElementById('step4-btn-save-captions');
  btn.className   = 'btn-primary btn-sm';
  btn.textContent = 'Save Captions';
  btn.disabled    = false;
}

function renderStep4CaptionGrid() {
  const grid = document.getElementById('step4-image-grid');
  if (!grid) return;
  grid.innerHTML = '';
  S.browseFiles.forEach(file => {
    const cell = document.createElement('div');
    cell.className = 'thumb-cell';

    const img = document.createElement('img');
    img.className = 'thumb-img';
    img.src       = `/api/drive/thumbnail/${file.id}`;
    img.alt       = file.name;
    img.loading   = 'lazy';
    img.onerror   = function() { this.replaceWith(makePlaceholder()); };

    const input = document.createElement('input');
    input.type        = 'text';
    input.className   = 'thumb-caption';
    input.value       = S.captions[file.id] || '';
    input.placeholder = 'Enter caption…';
    input.dataset.id  = file.id;
    input.addEventListener('input', () => {
      S.captions[file.id] = input.value;
      S.captionsDirty = true;
      const saveBtn = document.getElementById('step4-btn-save-captions');
      if (saveBtn && saveBtn.classList.contains('saved')) {
        saveBtn.className   = 'btn-primary btn-sm';
        saveBtn.textContent = 'Save Captions';
      }
    });

    cell.appendChild(img);
    cell.appendChild(input);
    grid.appendChild(cell);
  });
}

async function saveStep4Captions() {
  const btn = document.getElementById('step4-btn-save-captions');
  btn.disabled    = true;
  btn.textContent = 'Saving…';
  try {
    await api('POST', '/api/drive/save-captions', { captions: S.captions });
    S.captionsDirty = false;
    btn.className = 'btn-primary btn-sm saved';
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg> Saved`;
    btn.disabled  = false;
  } catch (err) {
    alert('Error saving captions: ' + err.message);
    btn.className   = 'btn-primary btn-sm';
    btn.textContent = 'Save Captions';
    btn.disabled    = false;
  }
}

async function uploadFiles() {
  if (!S.folderId) { alert('Create a Drive folder first (Step 2).'); return; }
  if (S.pendingUploads.length === 0) { alert('No files selected. Drag photos onto the drop zone or use Browse.'); return; }

  const btn   = document.getElementById('btn-upload-files');
  btn.disabled = true;
  hide('step4-error');
  hide('step4-success');

  const files = [...S.pendingUploads];
  const total  = files.length;

  // Build status rows — one per file with a spinner
  const list = document.getElementById('step4-pending-list');
  list.innerHTML = '';
  const hdr = document.createElement('p');
  hdr.className   = 'field-label';
  hdr.style.marginTop = '12px';
  hdr.id          = 'upload-hdr';
  hdr.textContent = `Uploading 1 of ${total}…`;
  list.appendChild(hdr);

  const statusEls = files.map((f, i) => {
    const row = document.createElement('div');
    row.className = 'attach-row';
    row.innerHTML = `
      <span class="attach-name">📷 ${esc(f.name)} <span style="color:#9ca3af;font-size:11px">${formatSize(f.size)}</span></span>
      <span class="upload-status-dot" id="ustatus-${i}"><span class="spinner-ring"></span></span>
    `;
    list.appendChild(row);
    return row;
  });

  let uploaded = 0;
  let failed   = 0;
  const succeededFiles = [];
  const failedIndexes  = new Set();

  for (let i = 0; i < files.length; i++) {
    const hdrEl = document.getElementById('upload-hdr');
    if (hdrEl) hdrEl.textContent = `Uploading ${i + 1} of ${total}…`;
    btn.textContent = `Uploading ${i + 1} of ${total}…`;

    const formData = new FormData();
    formData.append('folderId', S.folderId);
    formData.append('files', files[i]);

    try {
      const res  = await fetch('/api/drive/upload-files', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      document.getElementById(`ustatus-${i}`).innerHTML = '<span class="upload-ok">✓</span>';
      uploaded++;
      succeededFiles.push(...(data.files || []));
    } catch (err) {
      document.getElementById(`ustatus-${i}`).innerHTML = '<span class="upload-fail-icon">✗</span>';
      failedIndexes.add(i);
      failed++;
      console.error(`Upload failed for "${files[i].name}":`, err.message);
    }
  }

  const hdrEl = document.getElementById('upload-hdr');
  if (hdrEl) {
    hdrEl.textContent = failed
      ? `${uploaded} uploaded, ${failed} failed — failed files listed above`
      : `${uploaded} file${uploaded !== 1 ? 's' : ''} uploaded to Drive`;
  }

  S.copiedFiles    = [...S.copiedFiles, ...succeededFiles];
  S.pendingUploads = files.filter((_, i) => failedIndexes.has(i));

  btn.disabled    = (S.pendingUploads.length === 0);
  btn.textContent = '📷 Add to Post';

  if (failed > 0)   showError('step4-error', `${failed} file(s) failed to upload`);
  if (uploaded > 0) {
    showSuccess('step4-success', `${uploaded} file${uploaded !== 1 ? 's' : ''} saved to Drive`);
    show('btn-to-step5');
    if (S.mode === 'manual') showStep4CaptionGrid();
  }
}

function buildDoneSummary() {
  const album   = document.getElementById('step2-album-input')?.value || S.albumName || '';
  const excerpt = S.descBody ? S.descBody.slice(0, 200).trim() + (S.descBody.length > 200 ? '…' : '') : '(none)';
  const photoCount = S.arrangedFiles.length || S.copiedFiles.length;

  const sum = document.getElementById('done-summary');
  sum.innerHTML = `
    <div class="done-row"><span class="lbl">Album</span>   <span class="val">${esc(album)}</span></div>
    <div class="done-row"><span class="lbl">Folder</span>  <span class="val">${esc(S.folderName)}</span></div>
    <div class="done-row"><span class="lbl">Photos</span>  <span class="val">${photoCount} image${photoCount !== 1 ? 's' : ''} added to Drive</span></div>
    <div class="done-row done-row-desc"><span class="lbl">Description</span><span class="val desc-excerpt">${esc(excerpt)}</span></div>
  `;

  const links = document.getElementById('done-links');
  links.innerHTML = '';
  if (S.folderUrl) {
    links.innerHTML += `<a href="${S.folderUrl}" target="_blank" rel="noopener" class="btn-outline">📂 Open Drive Folder</a>`;
  }
  if (S.descDocUrl) {
    links.innerHTML += `<a href="${S.descDocUrl}" target="_blank" rel="noopener" class="btn-outline">📄 Open Description Doc</a>`;
  }
}

function _resetState() {
  S.selectedEmail  = null;
  S.emailDetail    = null;
  S.folderName     = '';
  S.folderId       = null;
  S.folderUrl      = null;
  S.descDocId      = null;
  S.descDocUrl     = null;
  S.descBody       = '';
  S.copiedFiles      = [];
  S.pendingUploads   = [];
  S.arrangedFiles    = [];
  S.captions         = {};
  S.selectedPhotoIdx = null;
  _revokeCandidateUrls();
  S.candidateFiles      = [];
  S.selectedCandidates  = new Set();
  S.candidateObjectUrls = {};
  S.failedUploadFiles   = [];
}

function _resetStep2UI() {
  hide('step2-success');
  hide('step2-error');
  const btn = document.getElementById('btn-create-folder');
  btn.disabled = false;
  btn.textContent = '📁 Create Folder';
  btn.hidden = false;
  hide('btn-to-step3');
}

function _resetStep3UI() {
  hide('step3-success');
  hide('step3-error');
  const btn = document.getElementById('btn-create-desc');
  btn.disabled = false;
  btn.textContent = '💾 Save Activity Description';
  btn.hidden = false;
  hide('btn-step3-edit-docs');
  hide('btn-to-step4');
  document.getElementById('step3-body-preview').value = '';
  S.descBody = '';
}

function _resetStep4UI() {
  hide('step4-success');
  hide('step4-error');
  hide('step4-caption-section');
  hide('step4-upload-overlay');
  expandDropZone();
  const copyBtn = document.getElementById('btn-copy-attaches');
  copyBtn.disabled = false;
  copyBtn.textContent = '📎 Copy Email Attachments to Drive';
  copyBtn.hidden = false;
  const uploadBtn = document.getElementById('btn-upload-files');
  uploadBtn.disabled = true;
  uploadBtn.textContent = '📷 Add to Post';
  hide('btn-to-step5');
  hide('btn-next-arrange');
  const nextBtn = document.getElementById('btn-next-arrange');
  if (nextBtn) nextBtn.disabled = true;
  document.getElementById('step4-attach-list').innerHTML = '';
  document.getElementById('step4-pending-list').innerHTML = '';
  const countEl = document.getElementById('step4-pending-count');
  if (countEl) countEl.textContent = '';
  S.pendingUploads = [];
  // Clean up manual mode candidate state
  _revokeCandidateUrls();
  S.candidateFiles      = [];
  S.selectedCandidates  = new Set();
  S.failedUploadFiles   = [];
  hide('step4-folder-picker');
  hide('step4-photo-picker');
  const folderNameEl = document.getElementById('step4-folder-name');
  if (folderNameEl) folderNameEl.style.display = 'none';
}

function _resetStep5UI() {
  hide('step5-success');
  hide('step5-error');
  document.getElementById('step5-gallery').innerHTML = '';
  document.getElementById('step5-empty').hidden = true;
  const btn = document.getElementById('btn-confirm-order');
  btn.disabled = false;
  btn.textContent = '✓ Confirm Order →';
  S.arrangedFiles    = [];
  S.selectedPhotoIdx = null;
  hide('step5-caption-editor');
}

function resetPipeline() {
  _resetState();
  _resetStep2UI();
  _resetStep3UI();
  _resetStep4UI();
  _resetStep5UI();

  if (S.mode === 'email') {
    document.getElementById('step2-email-section').hidden = false;
    document.getElementById('btn-process-email').disabled = true;
    S.currentStep = 1;
    updateStepUI();
    renderInbox();
  } else {
    document.getElementById('step2-email-section').hidden = true;
    const yr = new Date().getFullYear();
    document.getElementById('step2-album-input').value = yr + ' Album';
    document.getElementById('step2-folder-input').value = '';
    S.currentStep = 2;
    updateStepUI();
  }
}

// ============================================================
// STEP 5 — ARRANGE PHOTOS
// ============================================================

let _galleryDragSrc = null;

function renderGallery() {
  const gallery = document.getElementById('step5-gallery');
  const empty   = document.getElementById('step5-empty');

  if (S.arrangedFiles.length === 0) {
    gallery.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  gallery.innerHTML = '';

  S.arrangedFiles.forEach((f, i) => {
    const tile = document.createElement('div');
    tile.className   = 'photo-tile';
    tile.draggable   = true;
    tile.dataset.index = i;

    tile.addEventListener('dragstart', e => {
      _galleryDragSrc = i;
      tile.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    tile.addEventListener('dragend', () => {
      tile.classList.remove('dragging');
      gallery.querySelectorAll('.photo-tile').forEach(t => t.classList.remove('drag-over'));
    });
    tile.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      gallery.querySelectorAll('.photo-tile').forEach(t => t.classList.remove('drag-over'));
      tile.classList.add('drag-over');
    });
    tile.addEventListener('drop', e => {
      e.preventDefault();
      if (_galleryDragSrc === null || _galleryDragSrc === i) return;
      const moved = S.arrangedFiles.splice(_galleryDragSrc, 1)[0];
      S.arrangedFiles.splice(i, 0, moved);
      _galleryDragSrc = null;
      renderGallery();
    });
    tile.addEventListener('click', e => {
      if (e.target.closest('.btn-trash-photo')) return;
      selectGalleryTile(i);
    });

    const numBadge = document.createElement('div');
    numBadge.className   = 'photo-tile-num';
    numBadge.textContent = i + 1;

    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.src       = `/api/drive/thumbnail/${f.id}`;
    img.alt       = f.filename || f.name || '';
    img.loading   = 'lazy';
    img.onerror   = function() { this.replaceWith(makePlaceholder()); };

    const nameDiv = document.createElement('div');
    nameDiv.className   = 'photo-tile-name';
    nameDiv.title       = f.filename || f.name || '';
    nameDiv.textContent = f.filename || f.name || '';

    const trashBtn = document.createElement('button');
    trashBtn.className   = 'btn-trash-photo';
    trashBtn.title       = 'Remove from Drive';
    trashBtn.textContent = '🗑';
    trashBtn.onclick     = () => trashGalleryPhoto(i);

    if (S.selectedPhotoIdx === i) tile.classList.add('photo-tile-selected');

    tile.appendChild(numBadge);
    tile.appendChild(img);
    tile.appendChild(nameDiv);
    tile.appendChild(trashBtn);
    gallery.appendChild(tile);
  });
}

function selectGalleryTile(i) {
  S.selectedPhotoIdx = i;
  const f     = S.arrangedFiles[i];
  const label = document.getElementById('step5-caption-label');
  const input = document.getElementById('step5-caption-input');
  const editor = document.getElementById('step5-caption-editor');

  // Seed caption from filename if not yet edited
  if (S.captions[f.id] === undefined) {
    S.captions[f.id] = (f.filename || f.name || '')
      .replace(/^\d+_/, '').replace(/\.[^.]+$/, '');
  }

  label.textContent = `Caption — ${f.filename || f.name || ''}`;
  input.value = S.captions[f.id];
  editor.hidden = false;
  input.focus();

  document.querySelectorAll('#step5-gallery .photo-tile').forEach((t, idx) => {
    t.classList.toggle('photo-tile-selected', idx === i);
  });
}

function updateCaption() {
  if (S.selectedPhotoIdx === null) return;
  const f = S.arrangedFiles[S.selectedPhotoIdx];
  if (f) S.captions[f.id] = document.getElementById('step5-caption-input').value;
}

async function trashGalleryPhoto(i) {
  const f = S.arrangedFiles[i];
  if (!confirm(`Remove "${f.filename || f.name}" from Drive?`)) return;

  try {
    await api('DELETE', `/api/drive/trash-file?fileId=${encodeURIComponent(f.id)}`);
    S.arrangedFiles.splice(i, 1);
    S.copiedFiles = S.copiedFiles.filter(cf => cf.id !== f.id);
    renderGallery();
  } catch (err) {
    showError('step5-error', 'Could not remove file: ' + err.message);
  }
}

async function confirmPhotoOrder() {
  if (S.arrangedFiles.length === 0) { goToStep(6); return; }

  const btn = document.getElementById('btn-confirm-order');
  btn.disabled    = true;
  btn.textContent = 'Renaming…';
  hide('step5-error');

  try {
    const result = await api('POST', '/api/drive/reorder-files', {
      files: S.arrangedFiles.map(f => {
        const entry = { id: f.id, name: f.filename || f.name || f.id };
        const cap = S.captions[f.id];
        if (cap !== undefined && cap !== '') entry.description = cap;
        return entry;
      })
    });
    // Update local filenames to the prefixed versions
    if (result.files) {
      result.files.forEach((rf, idx) => {
        if (S.arrangedFiles[idx]) S.arrangedFiles[idx].filename = rf.name;
      });
    }
    S.copiedFiles = [...S.arrangedFiles];
    showSuccess('step5-success', 'Photos numbered and ready!');
    goToStep(6);
  } catch (err) {
    showError('step5-error', 'Could not rename files: ' + err.message);
    btn.disabled    = false;
    btn.textContent = '✓ Confirm Order →';
  }
}

function skipArrange() {
  buildDoneSummary();
  goToStep(6);
}

// ============================================================
// VIEW POSTS TAB — PHOTO ARCHIVE
// ============================================================

async function loadArchive() {
  const yearSel  = document.getElementById('archive-year-select');
  const eventSel = document.getElementById('archive-event-select');

  yearSel.disabled  = true;
  yearSel.innerHTML = '<option>Loading…</option>';
  eventSel.disabled  = true;
  eventSel.innerHTML = '<option>— Select a year first —</option>';
  hide('archive-event-card');
  hide('archive-load-error');
  hide('archive-loading');
  hide('archive-controls-error');
  show('archive-empty');

  try {
    const data = await api('GET', '/api/drive/list-albums');
    yearSel.innerHTML = '';
    if (!data.albums || !data.albums.length) {
      yearSel.innerHTML = '<option value="">No albums found</option>';
      return;
    }
    data.albums.forEach(album => {
      const opt = document.createElement('option');
      opt.value = album.id;
      opt.textContent = album.name;
      yearSel.appendChild(opt);
    });
    yearSel.disabled = false;
    onArchiveYearChange();
  } catch (err) {
    const errEl = document.getElementById('archive-controls-error');
    errEl.textContent = 'Failed to load albums: ' + err.message;
    errEl.hidden = false;
  }
}

async function onArchiveYearChange() {
  const yearSel  = document.getElementById('archive-year-select');
  const eventSel = document.getElementById('archive-event-select');
  const albumId  = yearSel.value;

  hide('archive-event-card');
  show('archive-empty');

  if (!albumId) {
    eventSel.disabled  = true;
    eventSel.innerHTML = '<option>— Select a year first —</option>';
    return;
  }

  eventSel.disabled  = true;
  eventSel.innerHTML = '<option>Loading…</option>';

  try {
    const data = await api('GET', `/api/drive/list-events?albumId=${encodeURIComponent(albumId)}`);
    eventSel.innerHTML = '';
    if (!data.events || !data.events.length) {
      eventSel.innerHTML = '<option value="">No events in this album</option>';
      return;
    }
    const placeholder = new Option('— Select an event —', '');
    eventSel.appendChild(placeholder);
    data.events.forEach(ev => {
      eventSel.appendChild(new Option(ev.name, ev.id));
    });
    eventSel.disabled = false;
    // Auto-select first event
    eventSel.selectedIndex = 1;
    onArchiveEventChange();
  } catch (_) {
    eventSel.innerHTML = '<option value="">Error loading events</option>';
  }
}

async function onArchiveEventChange() {
  const eventSel = document.getElementById('archive-event-select');
  const folderId = eventSel.value;

  hide('archive-empty');
  hide('archive-event-card');
  hide('archive-load-error');

  if (!folderId) { show('archive-empty'); return; }

  show('archive-loading');

  try {
    const data = await api('GET', `/api/drive/event-detail?folderId=${encodeURIComponent(folderId)}`);
    hide('archive-loading');

    document.getElementById('archive-event-title').textContent = data.folderName || '';
    document.getElementById('archive-drive-link').href = data.folderLink || '#';

    V.photos      = data.photos || [];
    V.carouselIdx = 0;
    renderArchiveCarousel();

    // Set up editable captions grid
    S.browseFolderId = data.folderId;
    S.browseFiles    = data.photos || [];
    S.captions       = {};
    S.captionsDirty  = false;
    S.browseFiles.forEach(f => { S.captions[f.id] = f.caption || ''; });
    document.getElementById('image-count-label').textContent =
      `${S.browseFiles.length} photo${S.browseFiles.length !== 1 ? 's' : ''} — click caption to edit`;
    renderImageGrid();
    updateCaptionSaveBtn(false);

    // Load editable description
    await loadDescription(data.folderId);

    const card = document.getElementById('archive-event-card');
    card.hidden = false;
    card.classList.remove('archive-slide-in');
    void card.offsetWidth;
    card.classList.add('archive-slide-in');
  } catch (_) {
    hide('archive-loading');
    show('archive-load-error');
  }
}

function renderArchiveCarousel() {
  const carousel = document.getElementById('archive-carousel');
  const noPhotos = document.getElementById('archive-no-photos');

  if (!V.photos.length) {
    carousel.hidden = true;
    noPhotos.hidden = false;
    return;
  }
  noPhotos.hidden = true;
  carousel.hidden = false;

  const photo = V.photos[V.carouselIdx];
  const img   = document.getElementById('archive-carousel-img');
  img.src = `/api/drive/thumbnail/${photo.id}`;
  img.alt = photo.name || '';

  document.getElementById('archive-carousel-caption').textContent = photo.caption || '';
  document.getElementById('archive-carousel-count').textContent =
    `${V.carouselIdx + 1} / ${V.photos.length}`;

  document.querySelector('.archive-carousel-prev').disabled = V.carouselIdx === 0;
  document.querySelector('.archive-carousel-next').disabled = V.carouselIdx === V.photos.length - 1;
}

function archiveCarouselPrev() {
  if (V.carouselIdx > 0) { V.carouselIdx--; renderArchiveCarousel(); }
}
function archiveCarouselNext() {
  if (V.carouselIdx < V.photos.length - 1) { V.carouselIdx++; renderArchiveCarousel(); }
}

// ============================================================
// UTILITIES  (browse & caption removed)
// ============================================================

async function _unused_browseFolder() {
  const albumName  = document.getElementById('browse-album').value.trim();
  const folderName = document.getElementById('browse-folder').value.trim();

  if (!albumName || !folderName) {
    showError('browse-error', 'Please enter both the album name and folder name.');
    return;
  }

  hide('browse-error');
  hide('browse-results');

  const btn = document.querySelector('.btn-browse');
  const origText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Loading…';

  try {
    const data = await api('POST', '/api/drive/browse-folder', {
      rootName:   'Council Activities',
      albumName,
      folderName
    });

    S.browseFolderId   = data.folderId;
    S.browseFolderLink = data.folderLink;
    S.browseFolderName = data.folderName;
    S.browsePath       = data.path;
    S.browseFiles      = data.files || [];
    S.captions         = {};
    S.browseFiles.forEach(f => { S.captions[f.id] = f.caption || ''; });
    S.captionsDirty = false;

    // Load description doc
    await loadDescription(data.folderId);

    renderBrowseResults();
    show('browse-results');
  } catch (err) {
    showError('browse-error', err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = origText;
  }
}

async function loadDescription(folderId) {
  S.descFileId  = null;
  S.descContent = '';
  S.descDirty   = false;

  try {
    const data = await api('GET', `/api/drive/get-description?folderId=${encodeURIComponent(folderId)}`);
    S.descFileId  = data.fileId;
    S.descContent = data.content || '';
    S.descDocUrl  = data.docUrl  || null;

    const noFile   = document.getElementById('desc-no-file');
    const label    = document.getElementById('desc-source-label');
    const ta       = document.getElementById('desc-textarea');
    const docsLink = document.getElementById('btn-edit-in-docs');

    if (!data.fileId) {
      noFile.hidden = false;
      label.textContent = 'No description document found · you can add one';
      ta.value = '';
      docsLink.hidden = true;
    } else {
      noFile.hidden = true;
      label.textContent = `${data.fileName} · editable`;
      ta.value = S.descContent;
      docsLink.href   = S.descDocUrl;
      docsLink.hidden = false;
    }
  } catch (err) {
    console.warn('get-description failed:', err.message);
  }

  updateDescSaveBtn(false);
}

function onDescInput() {
  S.descContent = document.getElementById('desc-textarea').value;
  S.descDirty   = true;
  updateDescSaveBtn(false);
  updateReviewDesc();
}

function updateDescSaveBtn(saved) {
  const btn = document.getElementById('btn-save-desc');
  if (saved) {
    btn.className = 'btn-primary btn-sm saved';
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg> Saved`;
  } else {
    btn.className = 'btn-primary btn-sm';
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg> Save Description`;
  }
}

async function saveDescription() {
  if (!S.descFileId) {
    alert('No description document found in this folder. Create one first via the Email Pipeline.');
    return;
  }

  const btn = document.getElementById('btn-save-desc');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await api('POST', '/api/drive/save-description', {
      fileId:  S.descFileId,
      content: S.descContent
    });
    S.descDirty = false;
    updateDescSaveBtn(true);
  } catch (err) {
    alert('Error saving description: ' + err.message);
    updateDescSaveBtn(false);
  } finally {
    btn.disabled = false;
  }
}

function renderBrowseResults() {
  // Review panel basics
  document.getElementById('rv-folder').textContent = S.browseFolderName;
  document.getElementById('rv-path').textContent   = S.browsePath;
  const driveLink = document.getElementById('rv-drive-link');
  driveLink.href = S.browseFolderLink || '#';

  document.getElementById('rv-count').textContent = S.browseFiles.length;
  document.getElementById('image-count-label').textContent =
    `${S.browseFiles.length} image${S.browseFiles.length !== 1 ? 's' : ''} · click caption to edit`;

  updateReviewDesc();
  renderImageGrid();
  renderReviewCaptions();
  updateCaptionSaveBtn(false);
}

let _dragSrcIndex = null;

function renderImageGrid() {
  const grid = document.getElementById('image-grid');
  grid.innerHTML = '';

  S.browseFiles.forEach((file, index) => {
    const cell = document.createElement('div');
    cell.className       = 'thumb-cell';
    cell.draggable       = true;
    cell.dataset.index   = index;

    // Drag events
    cell.addEventListener('dragstart', e => {
      _dragSrcIndex = index;
      cell.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    cell.addEventListener('dragend', () => {
      cell.classList.remove('dragging');
      grid.querySelectorAll('.thumb-cell').forEach(c => c.classList.remove('drag-over'));
    });
    cell.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      grid.querySelectorAll('.thumb-cell').forEach(c => c.classList.remove('drag-over'));
      cell.classList.add('drag-over');
    });
    cell.addEventListener('drop', e => {
      e.preventDefault();
      if (_dragSrcIndex === null || _dragSrcIndex === index) return;
      const moved = S.browseFiles.splice(_dragSrcIndex, 1)[0];
      S.browseFiles.splice(index, 0, moved);
      _dragSrcIndex = null;
      S.orderDirty = true;
      document.getElementById('btn-save-order').hidden = false;
      renderImageGrid();
      renderReviewCaptions();
    });

    const img = document.createElement('img');
    img.className = 'thumb-img';
    img.src       = `/api/drive/thumbnail/${file.id}`;
    img.alt       = file.name;
    img.loading   = 'lazy';
    img.onerror   = function() { this.replaceWith(makePlaceholder()); };

    const input = document.createElement('input');
    input.type        = 'text';
    input.className   = 'thumb-caption';
    input.value       = S.captions[file.id] || '';
    input.placeholder = 'Enter caption…';
    input.dataset.id  = file.id;
    input.addEventListener('input', () => {
      S.captions[file.id] = input.value;
      S.captionsDirty = true;
      updateCaptionSaveBtn(false);
      renderReviewCaptions();
    });

    cell.appendChild(img);
    cell.appendChild(input);
    grid.appendChild(cell);
  });
}

async function saveOrder() {
  const btn = document.getElementById('btn-save-order');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const result = await api('POST', '/api/drive/reorder-files', {
      files: S.browseFiles.map(f => ({ id: f.id, name: f.name }))
    });
    // Update local names to the renamed versions from server
    if (result.files) {
      result.files.forEach((rf, i) => { S.browseFiles[i].name = rf.name; });
    }
    S.orderDirty = false;
    btn.className    = 'btn-outline btn-sm saved';
    btn.innerHTML    = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg> Order Saved`;
    btn.disabled     = false;
  } catch (err) {
    alert('Error saving order: ' + err.message);
    btn.disabled  = false;
    btn.textContent = '⇅ Save Order';
  }
}

function makePlaceholder() {
  const div = document.createElement('div');
  div.className = 'thumb-placeholder';
  div.textContent = '🖼';
  return div;
}

function renderReviewCaptions() {
  const ol = document.getElementById('rv-captions');
  if (!ol) return;
  ol.innerHTML = '';
  S.browseFiles.forEach(file => {
    const li = document.createElement('li');
    const cap = S.captions[file.id] || '';
    li.textContent = cap || 'no caption';
    if (!cap) li.classList.add('empty');
    ol.appendChild(li);
  });
}

function updateReviewDesc() {
  const el = document.getElementById('rv-desc');
  if (!el) return;
  const desc = S.descContent || '';
  if (!desc) {
    el.textContent = 'no description';
    el.classList.add('empty');
  } else {
    el.textContent = desc.length > 160 ? desc.slice(0, 160) + '…' : desc;
    el.classList.remove('empty');
  }
}

function updateCaptionSaveBtn(saved) {
  const btn = document.getElementById('btn-save-captions');
  if (saved) {
    btn.className = 'btn-primary btn-sm saved';
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg> Saved`;
  } else {
    btn.className = 'btn-primary btn-sm';
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17,21 17,13 7,13 7,21"/><polyline points="7,3 7,8 15,8"/></svg> Save Captions`;
  }
}

async function saveCaptions() {
  if (S.browseFiles.length === 0) return;

  const btn = document.getElementById('btn-save-captions');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    await api('POST', '/api/drive/save-captions', { captions: S.captions });
    S.captionsDirty = false;
    updateCaptionSaveBtn(true);
  } catch (err) {
    alert('Error saving captions: ' + err.message);
    updateCaptionSaveBtn(false);
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// CORE UTILITIES
// ============================================================

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error(`Server returned an unexpected response (HTTP ${res.status}). Try refreshing.`);
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function show(id) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (el) el.hidden = false;
}

function hide(id) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (el) el.hidden = true;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showSuccess(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg> ${esc(msg)}`;
  el.hidden = false;
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function shortenEmail(sender) {
  // "John Doe <john@example.com>" → "john@example.com"
  const m = sender.match(/<([^>]+)>/);
  return m ? m[1] : sender;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ---- GOOGLE DOC SYNC — refresh textarea when user returns to this tab ----
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  if (S.currentStep !== 3 || !S.descDocId) return;

  const ta    = document.getElementById('step3-body-preview');
  const notice = document.getElementById('step3-sync-notice');
  if (notice) { notice.textContent = 'Refreshing from Google Doc…'; notice.hidden = false; }

  try {
    const data = await api('GET', `/api/drive/doc-content?fileId=${encodeURIComponent(S.descDocId)}`);
    const text = (data.content || '').trim();
    if (text && text !== S.descBody) {
      S.descBody  = text;
      ta.value    = text;
      if (notice) { notice.textContent = '✓ Refreshed from Google Doc'; }
    } else {
      if (notice) { notice.hidden = true; }
    }
  } catch (e) {
    if (notice) { notice.textContent = 'Could not refresh from Google Doc.'; }
  }

  if (notice && !notice.hidden) {
    setTimeout(() => { notice.hidden = true; }, 3000);
  }
});

// ---- BOOT ----
document.addEventListener('DOMContentLoaded', init);
