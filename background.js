/* Transaction Perf Recorder - service worker.
 *
 * A recording session follows one tab. Every user transaction becomes a record:
 *   navigation  - a full page load (or an action that triggered one), timed until the load event
 *                 has fired and the network has been quiet for `quietMs`
 *   action      - click / Enter / select change reported by the content script, timed until the
 *                 network has been quiet for `quietMs` (SPA / XHR / fetch work)
 *   manual      - started and ended from the popup, like lr_start_transaction / lr_end_transaction
 * Each transaction keeps the HTTP requests it caused with end-to-end timings from webRequest.
 */
importScripts('lib/stats.js', 'lib/store.js', 'lib/flows.js');

let S = { recording: false, tabId: null, sessionId: null, nextName: null, manual: null, replay: false };
let replay = null;      // active rerun of a saved flow
let session = null;     // full session object for the active recording
let current = null;     // open transaction (only one at a time)
let settings = null;
let ignoreRes = [];
const reqMap = new Map(); // requestId -> { tx, rec }
let quietTimer = null, maxTimer = null, persistTimer = null, sweepTimer = null;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) : s);

function compileIgnore() {
  ignoreRes = (settings.ignorePatterns || []).map((p) => { try { return new RegExp(p, 'i'); } catch (e) { return null; } }).filter(Boolean);
}

const ready = (async () => {
  settings = await Store.getSettings();
  compileIgnore();
  const rs = await Store.get('recState', null);
  if (rs && rs.recording && rs.sessionId) {
    let tabAlive = true;
    try { await chrome.tabs.get(rs.tabId); } catch (e) { tabAlive = false; }
    session = await Store.getSession(rs.sessionId);
    if (!session || !tabAlive) {
      if (session) { closeAllOpen(); session.endedAt = session.endedAt || Date.now(); await Store.saveSession(session); }
      session = null;
      S = { recording: false, tabId: null, sessionId: null, nextName: null, manual: null };
      await Store.set('recState', S);
    } else {
      S = rs;
      // The worker was restarted: timers are gone, so close what was open (manual ones stay open).
      for (const tx of session.transactions) {
        if (tx.status !== 'open') continue;
        if (tx.id === S.manual) { tx.inflight = 0; current = tx; }
        else closeTx(tx);
      }
    }
  }
  const rp = await Store.get('replayState', null);
  if (rp && rp.active) {
    await Store.set('replayState', Object.assign(rp, { active: false, status: 'failed', error: 'Service worker restarted during the rerun' }));
    if (rp.flowId) await Store.updateFlow(rp.flowId, (f) => { const r = f.runs.find((x) => x.sessionId === rp.sessionId); if (r) { r.status = 'failed'; r.error = 'interrupted'; } });
  }
  setBadge();
})();

const on = (fn) => (...args) => { ready.then(() => { try { fn(...args); } catch (e) { console.error('[TxPerf]', e); } }); };

/* ---------------- persistence ---------------- */

function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 400);
}
async function persist() {
  clearTimeout(persistTimer);
  if (session) await Store.saveSession(session);
  await Store.set('recState', S);
}

function setBadge() {
  if (S.recording && session) {
    const n = session.transactions.filter((t) => t.status === 'closed').length;
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    chrome.action.setBadgeText({ text: n ? String(n) : 'REC' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

/* ---------------- transactions ---------------- */

function nameTx(tx) {
  if (tx.customName) tx.name = tx.customName;
  else if (tx.type === 'navigation') tx.name = tx.label ? `${tx.label} → ${tx.navPage || tx.page}` : `Load ${tx.navPage || tx.page}`;
  else if (tx.type === 'action') tx.name = `${tx.label} @ ${tx.page}`;
  else tx.name = tx.label || 'Manual';
}

function newTx(type, start, info) {
  const tx = {
    id: uid(), seq: null, type, start, end: start, duration: null,
    label: info.label || '', kind: info.kind || type,
    pageUrl: info.pageUrl || '', page: PerfStats.pagePath(info.pageUrl || ''),
    navUrl: null, navPage: null, routeTo: null,
    customName: info.customName || null, name: '',
    requests: [], inflight: 0, status: 'open',
    navCompleted: type !== 'navigation', loadTime: null, dclTime: null, stopTime: null,
    reqCount: 0, errors: 0, bytes: 0
  };
  if (type === 'navigation') { tx.navUrl = info.pageUrl; tx.navPage = tx.page; }
  if (S.nextName && type !== 'manual') { tx.customName = S.nextName; S.nextName = null; }
  nameTx(tx);
  session.transactions.push(tx);
  current = tx;
  clearTimeout(maxTimer);
  if (type !== 'manual') maxTimer = setTimeout(() => { if (current === tx) { tx.truncated = true; closeTx(tx); } }, settings.maxTxMs);
  startSweep();
  persistSoon();
  return tx;
}

function recompute(tx) {
  let end = tx.start;
  let bytes = 0, errors = 0;
  for (const r of tx.requests) {
    if (r.end && !r.long && r.end > end) end = r.end;
    if (r.size) bytes += r.size;
    if (r.error || r.status >= 400) errors++;
  }
  if (tx.type === 'navigation' && tx.loadTime && tx.loadTime > end) end = tx.loadTime;
  if (tx.type === 'manual' && !tx.requests.length && tx.stopTime) end = tx.stopTime;
  tx.end = end;
  tx.duration = Math.round(end - tx.start);
  tx.reqCount = tx.requests.length;
  tx.errors = errors;
  tx.bytes = bytes;
}

function closeTx(tx) {
  if (!tx || tx.status === 'closed') return;
  tx.status = 'closed';
  tx.closedAt = Date.now();
  if (current === tx) { current = null; clearTimeout(quietTimer); clearTimeout(maxTimer); }
  if (S.manual === tx.id) S.manual = null;
  recompute(tx);
  if (tx.type === 'action' && !tx.requests.length && !settings.keepEmptyActions) {
    const i = session.transactions.indexOf(tx);
    if (i >= 0) session.transactions.splice(i, 1);
  } else {
    session.txCounter = (session.txCounter || 0) + 1;
    tx.seq = session.txCounter;
  }
  setBadge();
  persistSoon();
}

function closeAllOpen() {
  if (!session) return;
  for (const tx of session.transactions.slice()) if (tx.status === 'open') closeTx(tx);
  current = null;
}

function armQuiet() {
  clearTimeout(quietTimer);
  quietTimer = null;
  const tx = current;
  if (!tx || tx.status !== 'open' || tx.type === 'manual') return;
  if (tx.inflight > 0 || !tx.navCompleted) return;
  quietTimer = setTimeout(() => {
    if (current === tx && tx.inflight <= 0 && tx.navCompleted) closeTx(tx);
  }, settings.quietMs);
}

// Long-poll / streaming requests would keep a transaction open forever: stop counting them.
function startSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    if (!current) { clearInterval(sweepTimer); sweepTimer = null; return; }
    const t = Date.now();
    let changed = false;
    for (const r of current.requests) {
      if (!r.end && !r.long && t - r.start > settings.longRequestMs) { r.long = true; current.inflight = Math.max(0, current.inflight - 1); changed = true; }
    }
    if (changed) armQuiet();
  }, 1000);
}

// Requests that started at/after `ts` but were attributed elsewhere move to `tx`
// (the click message can reach the worker after the first request it triggered).
function adopt(tx, ts, prev) {
  const move = (list, from) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (r.start < ts - 5) continue;
      list.splice(i, 1);
      tx.requests.unshift(r);
      const m = reqMap.get(r.id);
      if (m) {
        m.tx = tx;
        if (!r.end && !r.long) { tx.inflight++; if (from) from.inflight = Math.max(0, from.inflight - 1); }
      }
    }
  };
  if (prev && prev.status === 'closed' && prev.requests.length) {
    move(prev.requests, prev);
    recompute(prev);
    if (prev.type === 'action' && !prev.requests.length && !settings.keepEmptyActions) {
      const i = session.transactions.indexOf(prev);
      if (i >= 0) session.transactions.splice(i, 1);
    }
  }
  if (session.unattributed.length) move(session.unattributed, null);
  tx.requests.sort((a, b) => a.start - b.start);
}

/* ---------------- recording control ---------------- */

async function startRecording(opts) {
  if (S.recording) await stopRecording();
  settings = await Store.getSettings();
  compileIgnore();
  session = {
    id: uid(), name: opts.name || ('Session ' + new Date().toLocaleString()),
    startedAt: Date.now(), endedAt: null, tabId: opts.tabId, startUrl: opts.url || '',
    transactions: [], unattributed: [], vitals: {}, steps: [], txCounter: 0, flowId: opts.flowId || null, replay: opts.replay || null,
    settings: Object.assign({}, settings), userAgent: navigator.userAgent
  };
  S = { recording: true, tabId: opts.tabId, sessionId: session.id, nextName: opts.nextName || null, manual: null, replay: !!opts.replay };
  if (!opts.replay && opts.url) session.steps.push({ kind: 'navigate', url: opts.url, ts: session.startedAt, implicit: true });
  current = null;
  reqMap.clear();
  await persist();
  try { await chrome.scripting.executeScript({ target: { tabId: opts.tabId, allFrames: true }, files: ['content/content.js'] }); } catch (e) { /* chrome:// pages etc. */ }
  if (opts.reload) chrome.tabs.reload(opts.tabId, { bypassCache: opts.reload === 'cold' });
  chrome.alarms.create('txperf-keepalive', { periodInMinutes: 0.5 });
  setBadge();
  return { ok: true, sessionId: session.id };
}

async function stopRecording() {
  if (!session) { S.recording = false; await Store.set('recState', S); setBadge(); return { ok: true }; }
  if (current && current.type === 'manual') current.stopTime = Date.now();
  closeAllOpen();
  session.endedAt = Date.now();
  const id = session.id;
  S = { recording: false, tabId: null, sessionId: null, nextName: null, manual: null, replay: false };
  if (!session.replay && !session.flowId && settings.autoSaveFlows && session.transactions.some((t) => t.status === 'closed') &&
      session.steps.some((x) => x.kind !== 'navigate' || !x.implicit)) {
    const flow = Flows.build(session, session.name);
    session.flowId = flow.id;
    await Store.saveFlow(flow);
  }
  await Store.saveSession(session);
  await Store.set('recState', S);
  session = null;
  reqMap.clear();
  chrome.alarms.clear('txperf-keepalive');
  setBadge();
  return { ok: true, sessionId: id };
}

function statusPayload() {
  if (!session) return { ok: true, state: S, replay: replayInfo() };
  const closed = session.transactions.filter((t) => t.status === 'closed');
  return {
    ok: true, state: S, replay: replayInfo(),
    session: { id: session.id, name: session.name, startedAt: session.startedAt, txCount: closed.length, vitalsCount: Object.keys(session.vitals).length },
    current: current ? { name: current.name, type: current.type, start: current.start, requests: current.requests.length, inflight: current.inflight } : null,
    recent: closed.slice(-12).reverse().map((t) => ({ name: t.name, type: t.type, duration: t.duration, reqCount: t.reqCount, errors: t.errors, seq: t.seq }))
  };
}

/* ---------------- webRequest ---------------- */

function ignored(d) {
  if (!/^https?:/i.test(d.url)) return true;
  if ((settings.ignoreTypes || []).includes(d.type)) return true;
  for (const re of ignoreRes) if (re.test(d.url)) return true;
  return false;
}

chrome.webRequest.onBeforeRequest.addListener(on((d) => {
  if (!S.recording || !session || d.tabId !== S.tabId) return;
  const known = reqMap.get(d.requestId);
  if (known) { // redirect hop: same requestId, new URL
    known.rec.redirects = (known.rec.redirects || 0) + 1;
    known.rec.url = trunc(d.url, 600);
    return;
  }
  if (ignored(d)) return;
  if (d.type === 'main_frame' && !(current && current.status === 'open' && (current.type === 'navigation' || current.type === 'manual'))) {
    startNavigation(d.timeStamp, d.url);
  }
  const rec = { id: d.requestId, method: d.method, url: trunc(d.url, 600), type: d.type, start: d.timeStamp, end: null, duration: null,
    status: null, fromCache: false, size: null, error: null, frame: d.frameId };
  const tx = current && current.status === 'open' ? current : null;
  if (tx) {
    tx.requests.push(rec);
    tx.inflight++;
    clearTimeout(quietTimer);
    reqMap.set(d.requestId, { tx, rec });
  } else if (settings.captureUnattributed) {
    session.unattributed.push(rec);
    if (session.unattributed.length > 5000) session.unattributed.splice(0, 1000);
    reqMap.set(d.requestId, { tx: null, rec });
  }
}), { urls: ['<all_urls>'] });

function headerSize(headers) {
  if (!headers) return null;
  const h = headers.find((x) => x.name.toLowerCase() === 'content-length');
  return h ? parseInt(h.value, 10) || null : null;
}

function requestDone(d, err) {
  const m = reqMap.get(d.requestId);
  if (!m) return;
  reqMap.delete(d.requestId);
  const { tx, rec } = m;
  rec.end = d.timeStamp;
  rec.duration = Math.round(rec.end - rec.start);
  if (err) rec.error = d.error;
  else { rec.status = d.statusCode; rec.fromCache = !!d.fromCache; rec.size = headerSize(d.responseHeaders); }
  if (tx) {
    if (!rec.long) tx.inflight = Math.max(0, tx.inflight - 1);
    if (tx.status === 'closed') recompute(tx);
    else if (tx === current) armQuiet();
  }
  persistSoon();
}

chrome.webRequest.onCompleted.addListener(on((d) => requestDone(d, false)), { urls: ['<all_urls>'] }, ['responseHeaders']);
chrome.webRequest.onErrorOccurred.addListener(on((d) => requestDone(d, true)), { urls: ['<all_urls>'] });

/* ---------------- navigation ---------------- */

function startNavigation(ts, url) {
  if (current && current.status === 'open') {
    if (current.type === 'manual') return;
    if (current.type === 'action' && ts - current.start <= settings.navMergeMs) {
      current.type = 'navigation';
      current.navCompleted = false;
      current.navUrl = url;
      current.navPage = PerfStats.pagePath(url);
      nameTx(current);
      return;
    }
    closeTx(current);
  }
  newTx('navigation', ts, { pageUrl: url });
}

const NAV_STEP_TRANSITIONS = ['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'reload', 'start_page'];
const mainFrame = (d) => S.recording && session && d.tabId === S.tabId && d.frameId === 0;
const openNav = () => (current && current.status === 'open' && current.type === 'navigation' ? current : null);

chrome.webNavigation.onBeforeNavigate.addListener(on((d) => {
  if (!mainFrame(d)) return;
  const nav = openNav();
  if (nav && !nav.committed && d.timeStamp - nav.start < 500) { nav.navUrl = d.url; nav.navPage = PerfStats.pagePath(d.url); nameTx(nav); return; }
  startNavigation(d.timeStamp, d.url);
}));

chrome.webNavigation.onCommitted.addListener(on((d) => {
  if (!mainFrame(d)) return;
  const nav = openNav();
  if (!nav) return;
  nav.committed = true;
  nav.navUrl = d.url;
  nav.navPage = PerfStats.pagePath(d.url);
  nav.transition = d.transitionType;
  if (!S.replay && !nav.label && NAV_STEP_TRANSITIONS.includes(d.transitionType)) {
    const st = session.steps;
    const last = st[st.length - 1];
    if (last && last.implicit && st.length === 1) st.pop(); // the start reload replaces the implicit start step
    st.push({ kind: 'navigate', url: d.url, ts: nav.start, txId: nav.id, transition: d.transitionType });
  }
  if (!nav.label) { nav.pageUrl = d.url; nav.page = nav.navPage; }
  nameTx(nav);
}));

chrome.webNavigation.onDOMContentLoaded.addListener(on((d) => {
  if (!mainFrame(d)) return;
  const nav = openNav();
  if (nav) nav.dclTime = d.timeStamp;
}));

chrome.webNavigation.onCompleted.addListener(on((d) => {
  if (!mainFrame(d)) return;
  const nav = openNav();
  if (!nav) return;
  nav.loadTime = d.timeStamp;
  nav.navCompleted = true;
  armQuiet();
}));

chrome.webNavigation.onErrorOccurred.addListener(on((d) => {
  if (!mainFrame(d)) return;
  const nav = openNav();
  if (!nav) return;
  nav.navError = d.error;
  nav.navCompleted = true;
  armQuiet();
}));

const routeChange = on((d) => {
  if (!mainFrame(d)) return;
  if (current && current.status === 'open') { current.routeTo = PerfStats.pagePath(d.url); current.routeUrl = d.url; }
});
chrome.webNavigation.onHistoryStateUpdated.addListener(routeChange);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(routeChange);

chrome.tabs.onRemoved.addListener(on((tabId) => {
  if (replay && tabId === replay.tabId) { replay.stopRequested = 'The rerun tab was closed'; return; }
  if (S.recording && tabId === S.tabId) stopRecording();
}));

/* ---------------- content script + UI messages ---------------- */

function onAction(msg, sender) {
  if (!S.recording || !session || S.replay || !sender.tab || sender.tab.id !== S.tabId) return;
  const ts = Math.min(msg.ts || Date.now(), Date.now());
  const step = { kind: msg.kind, label: msg.label, ts, pageUrl: sender.tab.url || msg.pageUrl, sel: msg.sel || null, value: msg.value == null ? null : msg.value };
  session.steps.push(step);
  if (current && current.status === 'open' && current.type === 'manual') {
    (current.actions = current.actions || []).push({ label: msg.label, ts: msg.ts });
    step.txId = current.id;
    return;
  }
  const prev = current;
  if (prev && prev.status === 'open') closeTx(prev);
  const tx = newTx('action', ts, { label: msg.label, kind: msg.kind, pageUrl: sender.tab.url || msg.pageUrl });
  step.txId = tx.id;
  adopt(tx, ts, prev);
  armQuiet();
}

function onVitals(msg, sender) {
  if (!S.recording || !session || !sender.tab || sender.tab.id !== S.tabId) return;
  const seg = msg.seg;
  if (!seg || !seg.id) return;
  seg.pre = seg.kind === 'hard' && seg.startEpoch < session.startedAt - 1000;
  seg.receivedAt = Date.now();
  session.vitals[seg.id] = seg;
  persistSoon();
}

async function handle(msg, sender) {
  switch (msg.cmd || msg.type) {
    case 'action': onAction(msg, sender); return { ok: true };
    case 'vitals': onVitals(msg, sender); return { ok: true };
    case 'step':
      if (S.recording && session && !S.replay && sender.tab && sender.tab.id === S.tabId) {
        session.steps.push({ kind: msg.kind, label: msg.label, ts: Math.min(msg.ts || Date.now(), Date.now()), pageUrl: sender.tab.url, sel: msg.sel || null, value: msg.value });
        persistSoon();
      }
      return { ok: true };
    case 'runFlow': return runFlow(msg.flowId, msg.opts || {});
    case 'stopFlow':
      if (replay) replay.stopRequested = 'Stopped by user';
      return { ok: true };
    case 'status': return statusPayload();
    case 'start': return startRecording(msg);
    case 'stop':
      if (replay) { replay.stopRequested = 'Stopped by user'; return { ok: true }; }
      return stopRecording();
    case 'nextName':
      S.nextName = msg.name || null;
      await Store.set('recState', S);
      return statusPayload();
    case 'manualStart': {
      if (!S.recording) return { ok: false, error: 'Not recording' };
      if (current && current.status === 'open') { if (current.type === 'manual') current.stopTime = Date.now(); closeTx(current); }
      const tx = newTx('manual', Date.now(), { label: msg.name, customName: msg.name || 'Manual' });
      S.manual = tx.id;
      if (!S.replay) session.steps.push({ kind: 'manualStart', name: msg.name || 'Manual', ts: tx.start, txId: tx.id });
      await persist();
      return statusPayload();
    }
    case 'manualEnd': {
      if (current && current.type === 'manual') { current.stopTime = Date.now(); closeTx(current); }
      if (!S.replay && session) session.steps.push({ kind: 'manualEnd', ts: Date.now() });
      S.manual = null;
      await persist();
      return statusPayload();
    }
    case 'renameSession': {
      if (session && session.id === msg.id) { session.name = msg.name; await persist(); }
      else { const s = await Store.getSession(msg.id); if (s) { s.name = msg.name; await Store.saveSession(s); } }
      return { ok: true };
    }
    case 'renameTx': { // rename every transaction called `from` in a session
      const apply = (s) => s.transactions.forEach((t) => { if (t.name === msg.from) { t.customName = msg.to; nameTx(t); } });
      if (session && session.id === msg.id) { apply(session); await persist(); }
      else { const s = await Store.getSession(msg.id); if (s) { apply(s); await Store.saveSession(s); } }
      return { ok: true };
    }
    case 'deleteSession': {
      if (session && session.id === msg.id) return { ok: false, error: 'Stop the recording first.' };
      await Store.deleteSession(msg.id);
      return { ok: true };
    }
    default: return { ok: false, error: 'unknown command' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ready.then(() => handle(msg, sender)).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    ready.then(async () => { settings = await Store.getSettings(); compileIgnore(); });
  }
});

chrome.alarms.onAlarm.addListener(() => { /* keeps the worker alive while recording */ });

/* ---------------- rerun of saved flows ----------------
 * Opens the flow's start URL in a new tab (warm-up load, not measured), starts a recording with a
 * reload (warm or cold cache), then performs each step through the content script. The worker opens
 * the action transaction itself just before the step is performed, named like the recorded one, so
 * reruns compare 1:1 with the recording and with baselines. */

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function checkStop() {
  if (replay && replay.stopRequested) throw new Error(replay.stopRequested);
}

// Waits in short slices and touches an extension API so the worker stays alive.
async function keepAwake(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    await pause(Math.min(1000, Math.max(0, end - performance.now())));
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* ignore */ }
    checkStop();
  }
}

function replayInfo() {
  if (!replay) return null;
  return { active: true, flowId: replay.flowId, flowName: replay.flowName, runNo: replay.runNo, sessionId: replay.sessionId,
    iteration: replay.iteration, iterations: replay.iterations, step: replay.step, steps: replay.steps.length, label: replay.label,
    errors: replay.errors.length, startedAt: replay.startedAt };
}
const saveReplayState = () => Store.set('replayState', replayInfo());

async function waitTabLoaded(tabId, timeout) {
  const t0 = performance.now();
  await keepAwake(200);
  while (performance.now() - t0 < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await keepAwake(250);
  }
}

async function waitIdle(timeout) {
  const t0 = performance.now();
  const limit = timeout || settings.maxTxMs + 5000;
  let calm = 0;
  while (performance.now() - t0 < limit) {
    checkStop();
    const busy = current && current.status === 'open' && current.type !== 'manual';
    calm = busy ? 0 : calm + 1;
    if (calm >= 3) return;
    await keepAwake(150);
  }
}

async function waitManualQuiet() {
  const t0 = performance.now();
  let quietSince = null;
  while (performance.now() - t0 < settings.maxTxMs) {
    checkStop();
    if (!current || current.type !== 'manual' || current.inflight <= 0) {
      if (quietSince == null) quietSince = performance.now();
      if (performance.now() - quietSince >= settings.quietMs) return;
    } else quietSince = null;
    await keepAwake(100);
  }
}

async function frameFor(frame) {
  if (!frame || frame === 'top') return 0;
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: replay.tabId });
    const f = (frames || []).find((x) => { try { const u = new URL(x.url); return u.origin + u.pathname === frame; } catch (e) { return false; } });
    return f ? f.frameId : 0;
  } catch (e) { return 0; }
}

async function doStep(st) {
  checkStop();
  if (st.kind === 'navigate') {
    S.nextName = st.txName || null;
    await chrome.tabs.update(replay.tabId, { url: st.url });
    await keepAwake(400);
    await waitIdle();
    return;
  }
  if (st.kind === 'manualStart') { await handle({ cmd: 'manualStart', name: st.name || 'Manual' }, {}); return; }
  if (st.kind === 'manualEnd') { await waitManualQuiet(); await handle({ cmd: 'manualEnd' }, {}); return; }
  const frameId = await frameFor(st.sel && st.sel.frame);
  const loc = await chrome.tabs.sendMessage(replay.tabId, { cmd: 'txperf-locate', step: st, timeout: settings.replayStepTimeoutMs }, { frameId })
    .catch((e) => ({ found: false, error: e.message }));
  if (!loc || !loc.found) throw new Error('Element not found: ' + st.label);
  checkStop();
  const manual = current && current.status === 'open' && current.type === 'manual';
  if (st.kind !== 'input' && !manual) {
    if (current && current.status === 'open') closeTx(current);
    let pageUrl = '';
    try { pageUrl = (await chrome.tabs.get(replay.tabId)).url; } catch (e) { /* ignore */ }
    newTx('action', Date.now(), { label: st.label, kind: st.kind, pageUrl, customName: st.txName || null });
    armQuiet();
  }
  const res = await chrome.tabs.sendMessage(replay.tabId, { cmd: 'txperf-act', step: st }, { frameId }).catch(() => ({ ok: true }));
  if (res && res.ok === false) throw new Error((res.error || 'failed') + ': ' + st.label);
  await keepAwake(150);
  if (!manual) await waitIdle();
}

async function runFlow(flowId, opts) {
  if (replay) return { ok: false, error: 'A rerun is already in progress.' };
  if (S.recording) return { ok: false, error: 'Stop the current recording first.' };
  const flow = await Store.getFlow(flowId);
  if (!flow) return { ok: false, error: 'Flow not found' };
  if (!flow.startUrl) return { ok: false, error: 'The flow has no start URL' };
  const o = Object.assign({ iterations: 1, think: 'recorded', thinkMs: 2000, cache: 'warm', stopOnError: true, closeTab: false }, opts);
  o.iterations = Math.max(1, Math.min(500, parseInt(o.iterations, 10) || 1));
  settings = await Store.getSettings();
  compileIgnore();
  replay = {
    flowId, flowName: flow.name, runNo: flow.runs.filter((r) => r.kind === 'rerun').length + 1, opts: o,
    steps: flow.steps.filter((s) => s.enabled !== false), iteration: 0, iterations: o.iterations, step: 0,
    label: 'Opening start page', errors: [], stopRequested: null, tabId: null, sessionId: null, startedAt: Date.now(), stepsOk: 0
  };
  await saveReplayState();
  replayLoop(flow);
  return { ok: true };
}

async function replayLoop(flow) {
  const r = replay, o = r.opts;
  let status = 'ok', error = null;
  try {
    const tab = await chrome.tabs.create({ url: flow.startUrl, active: true });
    r.tabId = tab.id;
    await waitTabLoaded(tab.id, 60000);
    const first = r.steps[0];
    const skipFirst = !!(first && first.kind === 'navigate' && PerfStats.pagePath(first.url) === PerfStats.pagePath(flow.startUrl));
    await startRecording({ tabId: tab.id, url: flow.startUrl, name: `${flow.name} – rerun ${r.runNo}`, reload: o.cache === 'cold' ? 'cold' : 'warm',
      replay: { runNo: r.runNo, iterations: o.iterations, think: o.think, thinkMs: o.thinkMs, cache: o.cache }, flowId: flow.id, nextName: skipFirst ? first.txName : null });
    r.sessionId = session.id;
    await Store.updateFlow(flow.id, (f) => f.runs.push({ sessionId: session.id, sessionName: session.name, kind: 'rerun', runNo: r.runNo,
      startedAt: session.startedAt, status: 'running', iterations: o.iterations, opts: o }));
    await saveReplayState();
    await keepAwake(500);
    await waitIdle();
    for (let it = 1; it <= o.iterations; it++) {
      r.iteration = it;
      if (it > 1 && !(first && first.kind === 'navigate')) {
        r.label = 'Open ' + flow.startUrl;
        await keepAwake(1000);
        await doStep({ kind: 'navigate', url: flow.startUrl });
      }
      for (let i = 0; i < r.steps.length; i++) {
        const st = r.steps[i];
        r.step = i + 1;
        r.label = Flows.stepText(st);
        if (it === 1 && i === 0 && skipFirst) { r.stepsOk++; continue; }
        await saveReplayState();
        const think = o.think === 'none' ? 0 : o.think === 'fixed' ? o.thinkMs : Math.min(st.think || 0, settings.replayMaxThinkMs);
        await keepAwake(Math.max(200, think || 0));
        try {
          await doStep(st);
          r.stepsOk++;
        } catch (e) {
          if (r.stopRequested) throw e;
          r.errors.push({ iteration: it, step: i + 1, label: r.label, error: e.message });
          if (o.stopOnError) throw e;
        }
      }
    }
  } catch (e) {
    status = r.stopRequested ? 'stopped' : 'failed';
    error = r.stopRequested || e.message;
  }
  if (status === 'ok' && r.errors.length) status = 'errors';
  const sid = r.sessionId;
  try { if (session && session.id === sid) await stopRecording(); } catch (e) { /* ignore */ }
  replay = null;
  if (sid) {
    await Store.updateFlow(r.flowId, (f) => {
      const run = f.runs.find((x) => x.sessionId === sid);
      if (run) Object.assign(run, { status, error, errors: r.errors, endedAt: Date.now(), stepsOk: r.stepsOk, stepsTotal: r.steps.length * r.iterations });
    });
  }
  await Store.set('replayState', { active: false, flowId: r.flowId, flowName: r.flowName, sessionId: sid, status, error, errors: r.errors.length, endedAt: Date.now() });
  if (o.closeTab && r.tabId) chrome.tabs.remove(r.tabId).catch(() => {});
}
