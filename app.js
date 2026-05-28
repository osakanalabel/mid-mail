// ── ストレージ ──────────────────────────────────────────────
const NS = 'mid-mail:v1';

function load() {
  try {
    return JSON.parse(localStorage.getItem(NS)) || {};
  } catch {
    return {};
  }
}

function save(data) {
  localStorage.setItem(NS, JSON.stringify(data));
}

function getData() {
  const d = load();
  return {
    recipients: d.recipients || [],
    templates:  d.templates  || [],
  };
}

function setData(patch) {
  save({ ...load(), ...patch });
}

// ── プレースホルダ展開 ─────────────────────────────────────
const PLACEHOLDERS = [
  { token: '<xxxx年xx月xx日>', label: '長い日付', expand: () => {
    const d = new Date();
    return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
  }},
  { token: '<MM/DD>', label: '短い日付', expand: () => {
    const d = new Date();
    return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
  }},
];

function expandPlaceholders(text) {
  let result = text;
  for (const p of PLACEHOLDERS) {
    result = result.replaceAll(p.token, p.expand());
  }
  return result;
}

// ── ID生成 ─────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Gmail 送信 ─────────────────────────────────────────────
let accessToken = null;
let tokenClient = null;

const TOKEN_KEY = NS + ':token';

function loadStoredToken() {
  try {
    const { token, expiresAt } = JSON.parse(localStorage.getItem(TOKEN_KEY) || '{}');
    if (token && expiresAt && Date.now() < expiresAt) return token;
  } catch {}
  return null;
}

function storeToken(token, expiresInSec) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    token,
    expiresAt: Date.now() + expiresInSec * 1000,
  }));
}

function clearStoredToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.clientId,
    scope: 'https://www.googleapis.com/auth/gmail.send email profile',
    prompt: '',
    callback: async (resp) => {
      if (resp.error) {
        showToast('認証に失敗しました', 'error');
        return;
      }
      accessToken = resp.access_token;
      storeToken(resp.access_token, Number(resp.expires_in) || 3600);
      $('overlay-auth').classList.add('hidden');
      await fetchAndShowEmail();
      showSetupToast();
    },
  });
}

async function fetchAndShowEmail() {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    const data = await res.json();
    const name  = data.name  || '';
    const email = data.email || '';
    $('from-email').textContent = name ? `${name}<${email}>` : email;
  } catch {
    $('from-email').textContent = '';
  }
}

function signOut() {
  google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null;
  clearStoredToken();
  $('from-email').textContent = '';
  hideSetupToast();
  $('overlay-auth').classList.remove('hidden');
}

function encodeBase64url(str) {
  // RFC5322メッセージはASCII範囲で組み立てるのでそのままbtoaできる
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeMimeWord(str) {
  return '=?UTF-8?B?' + btoa(unescape(encodeURIComponent(str))) + '?=';
}

function buildRfc5322(to, subject, body, cc, bcc) {
  const encodedSubject = /[^\x00-\x7F]/.test(subject) ? encodeMimeWord(subject) : subject;
  const lines = [
    'To: ' + to,
    ...(cc  ? ['Cc: '  + cc]  : []),
    ...(bcc ? ['Bcc: ' + bcc] : []),
    'Subject: ' + encodedSubject,
    'X-Mailer: MID-MAIL',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    btoa(unescape(encodeURIComponent(body))),
  ];
  return lines.join('\r\n');
}

async function sendEmail(to, subject, body, cc, bcc) {
  const raw = encodeBase64url(buildRfc5322(to, subject, body, cc, bcc));
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || 'Gmail API error');
  }
}

function requestTokenAndSend(to, subject, body) {
  if (accessToken) {
    doSend(to, subject, body);
  } else {
    // トークン切れ：再認証してから送信
    const orig = tokenClient.callback;
    tokenClient.callback = async (resp) => {
      if (resp.error) {
        showToast('認証に失敗しました', 'error');
        tokenClient.callback = orig;
        return;
      }
      accessToken = resp.access_token;
      $('overlay-auth').classList.add('hidden');
      tokenClient.callback = orig;
      await fetchAndShowEmail();
      await doSend(to, subject, body);
    };
    tokenClient.requestAccessToken();
  }
}

async function doSend(to, subject, body) {
  const selfEmail = $('from-email').textContent.replace(/.*<(.+)>/, '$1') || $('from-email').textContent;
  const cc  = $('chk-cc-self').checked  ? selfEmail : null;
  const bcc = $('chk-bcc-self').checked ? selfEmail : null;
  setBtnSendLoading(true);
  try {
    await sendEmail(to, subject, body, cc, bcc);
    showToast('送信しました', 'success');
  } catch (e) {
    if (e.message.includes('401') || e.message.includes('invalid')) {
      accessToken = null;
      clearStoredToken();
      $('overlay-auth').classList.remove('hidden');
      showToast('認証切れです。再度サインインしてください', 'error');
    } else {
      showToast('送信失敗: ' + e.message, 'error');
    }
  } finally {
    setBtnSendLoading(false);
  }
}

// ── UI ヘルパー ────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function resetToastAnimation(el) {
  el.style.animation = 'none';
  el.offsetHeight; // reflow
  el.style.animation = '';
}

function showToast(msg, type = 'success') {
  const el = $('toast');
  if (el._setupHandler) {
    el.removeEventListener('click', el._setupHandler);
    el._setupHandler = null;
  }
  el.textContent = msg;
  el.className = [
    'fixed top-4 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl text-white text-sm font-medium shadow-lg',
    type === 'success' ? 'bg-green-600' : 'bg-red-500',
  ].join(' ');
  el.classList.remove('hidden');
  resetToastAnimation(el);
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function setBtnSendLoading(loading) {
  const btn = $('btn-send');
  btn.disabled = loading;
  btn.textContent = loading ? '送信中…' : '送信';
}

function setView(name) {
  $('view-settings').classList.toggle('hidden', name !== 'settings');
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

// ── メイン画面 ─────────────────────────────────────────────
function populateSelects() {
  const { recipients, templates } = getData();
  const last = JSON.parse(localStorage.getItem(NS + ':last') || '{}');

  const rSel = $('select-recipient');
  rSel.innerHTML = recipients.length
    ? recipients.map(r => `<option value="${r.id}">${r.label}</option>`).join('')
    : '<option value="">（送り先なし）</option>';
  if (last.recipientId && recipients.find(r => r.id === last.recipientId)) {
    rSel.value = last.recipientId;
  }

  const tSel = $('select-template');
  tSel.innerHTML = templates.length
    ? templates.map(t => `<option value="${t.id}">${t.label}</option>`).join('')
    : '<option value="">（定型文なし）</option>';
  if (last.templateId && templates.find(t => t.id === last.templateId)) {
    tSel.value = last.templateId;
  }

  $('chk-cc-self').checked  = !!last.ccSelf;
  $('chk-bcc-self').checked = !!last.bccSelf;

  updatePreview();
  updateSendBtn();
  showSetupToast();
}

function updatePreview() {
  const { templates } = getData();
  const tId = $('select-template').value;
  const t = templates.find(x => x.id === tId);
  $('preview-subject').value = t ? t.subject : '';
  $('preview-body').value    = t ? t.body    : '';
}

function updateSendBtn() {
  const { recipients, templates } = getData();
  const hasR = recipients.length > 0 && $('select-recipient').value;
  const hasT = templates.length > 0 && $('select-template').value;
  $('btn-send').disabled = !(hasR && hasT);
}

function hideSetupToast() {
  const el = $('toast-setup');
  if (el) el.style.display = 'none';
  const arrow = $('toast-setup-arrow');
  if (arrow) arrow.style.display = 'none';
}

function showSetupToast() {
  const { recipients, templates } = getData();
  const noR = recipients.length === 0;
  const noT = templates.length === 0;
  if (!noR && !noT) return;
  let el = $('toast-setup');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast-setup';
    document.body.appendChild(el);
  }
  el.className = '';
  el.style.cssText = 'display:block; position:fixed; top:5rem; right:0.75rem; z-index:45; max-width:7rem; padding:0.5rem 0.75rem; border-radius:0.75rem; color:#fff; font-size:0.75rem; font-weight:600; text-align:center; line-height:1.3; cursor:pointer; background:linear-gradient(225deg, #e8a42a 0%, #D4891A 50%, #b57215 100%); box-shadow:-5px 8px 16px rgba(0,0,0,0.7);';
  el.textContent = '未設定項目があります';

  let arrow = $('toast-setup-arrow');
  if (!arrow) {
    arrow = document.createElement('div');
    arrow.id = 'toast-setup-arrow';
    document.body.appendChild(arrow);
  }
  arrow.style.cssText = 'display:block; position:fixed; top:3.8rem; right:1.5rem; z-index:44; pointer-events:none; width:0; height:0; border-left:12px solid transparent; border-right:12px solid transparent; border-bottom:18px solid #D4891A;';

  clearTimeout(el._timer);
  el._timer = null;
  el.onclick = () => {
    hideSetupToast();
    renderSettings();
    setView('settings');
  };
}

// ── 設定画面 ───────────────────────────────────────────────
function renderSettings() {
  const { recipients, templates } = getData();

  $('list-recipients').innerHTML = recipients.map(r => `
    <li class="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-cream-dark">
      <div>
        <p class="text-sm font-medium">${escHtml(r.label)}</p>
        <p class="text-xs text-gray-400">${escHtml(r.email)}</p>
      </div>
      <button class="text-amber text-sm font-medium" data-edit-recipient="${r.id}">編集</button>
    </li>
  `).join('');

  $('list-templates').innerHTML = templates.map(t => `
    <li class="flex items-center justify-between bg-white rounded-xl px-4 py-3 border border-cream-dark">
      <div class="min-w-0 mr-2">
        <p class="text-sm font-medium">${escHtml(t.label)}</p>
        <p class="text-xs text-gray-400 truncate">${escHtml(t.subject)}</p>
      </div>
      <button class="text-amber text-sm font-medium shrink-0" data-edit-template="${t.id}">編集</button>
    </li>
  `).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 送り先モーダル ─────────────────────────────────────────
let editingRecipientId = null;

function openRecipientModal(id = null) {
  editingRecipientId = id;
  const r = id ? getData().recipients.find(x => x.id === id) : null;
  $('modal-recipient-label').value = r ? r.label : '';
  $('modal-recipient-email').value = r ? r.email : '';
  $('modal-recipient-delete').classList.toggle('hidden', !id);
  openModal('modal-recipient');
}

function saveRecipient() {
  const label = $('modal-recipient-label').value.trim();
  const email = $('modal-recipient-email').value.trim();
  if (!label || !email) { showToast('名前とメールアドレスを入力してください', 'error'); return; }

  const data = getData();
  if (editingRecipientId) {
    data.recipients = data.recipients.map(r =>
      r.id === editingRecipientId ? { ...r, label, email } : r
    );
  } else {
    data.recipients.push({ id: uid(), label, email });
  }
  setData({ recipients: data.recipients });
  closeModal('modal-recipient');
  renderSettings();
  populateSelects();
}

function deleteRecipient() {
  if (!editingRecipientId) return;
  const data = getData();
  data.recipients = data.recipients.filter(r => r.id !== editingRecipientId);
  setData({ recipients: data.recipients });
  closeModal('modal-recipient');
  renderSettings();
  populateSelects();
}

// ── 定型文モーダル ─────────────────────────────────────────
let editingTemplateId = null;

function openTemplateModal(id = null) {
  editingTemplateId = id;
  const t = id ? getData().templates.find(x => x.id === id) : null;
  $('modal-template-label').value   = t ? t.label   : '';
  $('modal-template-subject').value = t ? t.subject : '';
  $('modal-template-body').value    = t ? t.body    : '';
  $('modal-template-delete').classList.toggle('hidden', !id);

  // プレースホルダ挿入ボタンを生成（件名・本文共通）
  function makePlaceholderBtns(containerId, targetId) {
    const container = $(containerId);
    container.innerHTML = PLACEHOLDERS.map(p =>
      `<button type="button" data-token="${p.token}"
        class="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-600 bg-white active:bg-gray-100">
        ${p.label}
      </button>`
    ).join('');
    container.onclick = (e) => {
      const token = e.target.closest('[data-token]')?.dataset.token;
      if (!token) return;
      const el = $(targetId);
      const start = el.selectionStart;
      const end   = el.selectionEnd;
      el.value = el.value.slice(0, start) + token + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + token.length;
      el.focus();
    };
  }
  makePlaceholderBtns('placeholder-btns-subject', 'modal-template-subject');
  makePlaceholderBtns('placeholder-btns', 'modal-template-body');

  openModal('modal-template');
}

function saveTemplate() {
  const label   = $('modal-template-label').value.trim();
  const subject = $('modal-template-subject').value.trim();
  const body    = $('modal-template-body').value.replace(/\r\n|\r|\n/g, '\n');
  if (!label || !subject) { showToast('名前と件名を入力してください', 'error'); return; }

  const data = getData();
  if (editingTemplateId) {
    data.templates = data.templates.map(t =>
      t.id === editingTemplateId ? { ...t, label, subject, body } : t
    );
  } else {
    data.templates.push({ id: uid(), label, subject, body });
  }
  setData({ templates: data.templates });
  closeModal('modal-template');
  renderSettings();
  populateSelects();
}

function deleteTemplate() {
  if (!editingTemplateId) return;
  const data = getData();
  data.templates = data.templates.filter(t => t.id !== editingTemplateId);
  setData({ templates: data.templates });
  closeModal('modal-template');
  renderSettings();
  populateSelects();
}

// ── イベント登録 ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  populateSelects();

  // GIS読み込み完了を待って認証初期化・オーバーレイ表示
  // GISはasync読み込みのためポーリングで待つ
  const waitForGis = setInterval(() => {
    if (typeof google === 'undefined') return;
    clearInterval(waitForGis);
    initAuth();
    // 保存済みトークンが有効ならオーバーレイをスキップ
    const stored = loadStoredToken();
    if (stored) {
      accessToken = stored;
      $('overlay-auth').classList.add('hidden');
      fetchAndShowEmail();
    }
    // サインインボタン（明示的なサインインなのでアカウント選択を出す）
    $('btn-auth').addEventListener('click', () => {
      tokenClient.requestAccessToken({ prompt: 'select_account' });
    });
  }, 100);

  // サインアウト
  $('btn-signout').addEventListener('click', () => openModal('dialog-signout'));
  $('btn-signout-cancel').addEventListener('click', () => closeModal('dialog-signout'));
  $('btn-signout-confirm').addEventListener('click', () => {
    closeModal('dialog-signout');
    signOut();
  });

  // 設定画面 開閉
  $('btn-settings').addEventListener('click', () => {
    hideSetupToast();
    renderSettings();
    setView('settings');
  });
  $('btn-settings-close').addEventListener('click', () => {
    setView('main');
    populateSelects();
  });

  // セレクト変更
  $('select-template').addEventListener('change', updatePreview);
  $('select-recipient').addEventListener('change', updateSendBtn);

  // 送信ボタン → 確認ダイアログ
  $('btn-send').addEventListener('click', () => {
    const { recipients } = getData();
    const rId = $('select-recipient').value;
    const r = recipients.find(x => x.id === rId);
    if (!r) return;
    $('dialog-to').textContent = '送信先：' + r.email;
    openModal('dialog-confirm');
  });

  $('btn-cancel').addEventListener('click', () => closeModal('dialog-confirm'));

  $('btn-confirm').addEventListener('click', () => {
    closeModal('dialog-confirm');
    const { recipients, templates } = getData();
    const r = recipients.find(x => x.id === $('select-recipient').value);
    const t = templates.find(x => x.id === $('select-template').value);
    if (!r || !t) return;
    localStorage.setItem(NS + ':last', JSON.stringify({
      recipientId: r.id,
      templateId:  t.id,
      ccSelf:  $('chk-cc-self').checked,
      bccSelf: $('chk-bcc-self').checked,
    }));
    const subject = $('preview-subject').value;
    const body    = $('preview-body').value.replace(/\r\n|\r|\n/g, '\r\n');
    requestTokenAndSend(r.email, expandPlaceholders(subject), expandPlaceholders(body));
  });

  // 送り先
  $('btn-add-recipient').addEventListener('click', () => openRecipientModal());
  $('modal-recipient-cancel').addEventListener('click', () => closeModal('modal-recipient'));
  $('modal-recipient-save').addEventListener('click', saveRecipient);
  $('modal-recipient-delete').addEventListener('click', deleteRecipient);

  // 定型文
  $('btn-add-template').addEventListener('click', () => openTemplateModal());
  $('modal-template-cancel').addEventListener('click', () => closeModal('modal-template'));
  $('modal-template-save').addEventListener('click', saveTemplate);
  $('modal-template-delete').addEventListener('click', deleteTemplate);

  // 設定リストの編集ボタン（委譲）
  $('list-recipients').addEventListener('click', e => {
    const id = e.target.dataset.editRecipient;
    if (id) openRecipientModal(id);
  });
  $('list-templates').addEventListener('click', e => {
    const id = e.target.dataset.editTemplate;
    if (id) openTemplateModal(id);
  });

  // ダイアログ背景クリックで閉じる
  ['dialog-confirm', 'dialog-signout', 'modal-recipient', 'modal-template'].forEach(id => {
    $(id).addEventListener('click', e => {
      if (e.target === $(id)) closeModal(id);
    });
  });
});
