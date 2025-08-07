// ==UserScript==
// @name         Torn – 30-day Stats
// @namespace    https://www.torn.com/
// @version      1.68
// @description  30-day play-time, xanax & streak on profile pages, search lists, and all faction pages
// @match        https://www.torn.com/profiles.php?XID=*
// @match        https://www.torn.com/page.php?sid=UserList*
// @match        https://www.torn.com/userlist.php*
// @match        https://www.torn.com/factions.php?step=your*
// @match        https://www.torn.com/factions.php?step=profile&ID=*
// @updateURL   https://raw.githubusercontent.com/OGBobB/act/main/Torn30dayStats.user.js
// @downloadURL https://raw.githubusercontent.com/OGBobB/act/main/Torn30dayStats.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.torn.com
// @inject-into  page
// ==/UserScript==

/*──────── CONFIG ─────────*/
const GAP_MS          = 600;
const CACHE_EXPIRY_MS = 2 * 60 * 60 * 1000; // 2 hours
/*─────────────────────────*/

let API_KEY = GM_getValue('torn_api_key');
if (!API_KEY) {
  API_KEY = prompt('Enter your Torn API key:');
  if (API_KEY) {
    GM_setValue('torn_api_key', API_KEY);
  } else {
    alert('⚠️ Torn API key is required for the script to work.');
    throw new Error('No API key provided');
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

let lastStart = 0;
function queuedGET(url) {
  const now = Date.now();
  const delay = Math.max(0, lastStart + GAP_MS - now);
  lastStart = now + delay;
  return new Promise((resolve, reject) => {
    setTimeout(() => directGET(url).then(resolve).catch(reject), delay);
  });
}

function directGET(url) {
  return new Promise((resolve, reject) =>
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      onload: r => {
        const j = JSON.parse(r.responseText);
        j.error ? reject(j.error) : resolve(j);
      },
      onerror: reject,
      ontimeout: reject
    })
  );
}

function pick(ps, path, arr) {
  let o = ps;
  for (const k of path) o = o?.[k];
  if (o !== undefined) return o;
  if (Array.isArray(ps)) return (ps.find(e => e.name === arr) || {}).value ?? 0;
  return 0;
}

function getCachedSnapshot(xid, days) {
  const key = `snap:${xid}:${days}`;
  const cached = localStorage.getItem(key);
  if (!cached) return null;
  try {
    const { ts, data } = JSON.parse(cached);
    if (Date.now() - ts < CACHE_EXPIRY_MS) return data;
  } catch (e) {
    localStorage.removeItem(key);
  }
  return null;
}

function setCachedSnapshot(xid, days, data) {
  const key = `snap:${xid}:${days}`;
  localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
}

async function snapshot30d(xid, getter, daySpan = 30) {
  const cached = getCachedSnapshot(xid, daySpan);
  if (cached) return cached;

  const base = `https://api.torn.com/v2/user/${xid}/personalstats?stat=`;
  const nowURL = base + 'timeplayed,xantaken,activestreak&key=' + API_KEY;
  const ts = Math.floor(Date.now() / 1000) - daySpan * 86400;
  const oldURL = base + 'timeplayed,xantaken&timestamp=' + ts + '&key=' + API_KEY;

  const [nowRes, oldRes] = await Promise.all([
    getter(nowURL).then(r => r.personalstats),
    getter(oldURL).then(r => r.personalstats).catch(() => null)
  ]);

  const nowPlay = pick(nowRes, ['other', 'activity', 'time'], 'timeplayed');
  const nowXan = pick(nowRes, ['drugs', 'xanax'], 'xantaken');
  const nowStreak = pick(nowRes, ['other', 'activity', 'streak', 'current'], 'activestreak');

  const oldPlay = oldRes ? pick(oldRes, ['other', 'activity', 'time'], 'timeplayed') : nowPlay;
  const oldXan = oldRes ? pick(oldRes, ['drugs', 'xanax'], 'xantaken') : nowXan;

  const result = {
    play: Math.max(0, nowPlay - oldPlay),
    xan: Math.max(0, nowXan - oldXan),
    streak: nowStreak
  };
  setCachedSnapshot(xid, daySpan, result);
  return result;
}

function paintBadge(row, data) {
  const s = data.play,
        d = Math.floor(s / 86400),
        h = Math.floor(s % 86400 / 3600),
        m = Math.floor(s % 3600 / 60);

  let color;
  if (s >= 86400) color = 'limegreen';     // ≥ 1 day
  else if (s >= 10800) color = 'orange';   // ≥ 3h
  else color = 'red';                      // < 3h

  const badge = document.createElement('div');
  badge.textContent = `⏱️ ${d}d ${h}h ${m}m  💊${data.xan} 🔥${data.streak}`;
  badge.className = 'torn-badge-container';
  badge.style = `font-size:11px;font-weight:600;color:${color};margin-top:2px;white-space:nowrap;`;

  const lastAction = row.querySelector('.last-action');
  if (lastAction?.parentElement) {
    lastAction.parentElement.appendChild(badge);
  } else {
    row.appendChild(badge);
  }
}

async function fetchAndPaintWithRetry(row, xid, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const data = await snapshot30d(xid, queuedGET);
      paintBadge(row, data);
      return;
    } catch (e) {
      console.warn(`Attempt ${attempt} failed for XID=${xid}`, e);
      if (attempt < retries) await sleep(300 * attempt);
    }
  }
  console.warn(`❌ All retries failed for XID=${xid}`);
}

if (location.pathname.startsWith('/factions.php')) {
  const observer = new MutationObserver(() => {
    (async () => {
      const rows = Array.from(document.querySelectorAll('.table-row'));
      for (const row of rows) {
        if (row.dataset.badged) continue;
        row.dataset.badged = '1';
        const link = row.querySelector('a[href*="XID="]');
        const match = link?.href.match(/XID=(\d+)/);
        if (!match) continue;
        const xid = match[1];
        await fetchAndPaintWithRetry(row, xid);
      }
    })();
  });

  const waitForWrap = setInterval(() => {
    const container = document.querySelector('.faction-info-wrap');
    if (!container) return;
    clearInterval(waitForWrap);
    observer.observe(container, { childList: true, subtree: true });
  }, 250);
}

if ((location.pathname === '/page.php' && location.search.includes('sid=UserList')) || location.pathname === '/userlist.php') {
  const observer = new MutationObserver(() => {
    document.querySelectorAll('ul.user-info-list-wrap li').forEach(async li => {
      if (li.dataset.badged) return;
      li.dataset.badged = '1';
      const link = li.querySelector('a.user.name[href*="profiles.php?XID="]');
      const xid = link ? link.href.match(/XID=(\d+)/)?.[1] : null;
      if (!xid) return;
      const data = await snapshot30d(xid, queuedGET);
      paintBadge(li, data);
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (location.pathname.startsWith('/profiles.php')) {
  (async () => {
    const XID = new URLSearchParams(location.search).get('XID');
    if (!XID) return;

    const dayOpts = [1, 7, 30];
    const cache = {};
    const h4 = document.querySelector('.content-title h4');
    if (!h4) return;

    const sel = document.createElement('select');
    sel.style = 'margin:8px 0;font-size:12px;';
    dayOpts.forEach(d => sel.innerHTML += `<option value="${d}">${d}d</option>`);
    sel.value = '30';
    h4.after(sel);

    const warn = document.createElement('div');
    warn.style = 'font-size:11px;color:orange;display:none;';
    sel.after(warn);

    const wait = document.createElement('div');
    wait.textContent = 'Loading…';
    wait.style = 'font-size:11px;color:gray;';
    warn.after(wait);

    // Add Reset API Key Button
    const resetBtn = document.createElement('button');
    resetBtn.textContent = '🔑 Reset API Key';
    resetBtn.style = 'margin:8px 0;font-size:11px;';
    resetBtn.onclick = () => {
      GM_setValue('torn_api_key', '');
      location.reload();
    };
    wait.after(resetBtn);

    async function render(day) {
      const data = await snapshot30d(XID, directGET, day);
      const box = document.createElement('div');
      box.className = `dstat-${day}`;
      box.style = 'margin-top:4px;font-size:12px;';
      const d = Math.floor(data.play / 86400),
            h = Math.floor(data.play % 86400 / 3600),
            m = Math.floor(data.play % 3600 / 60);
      box.innerHTML =
        `<div style="color:#8ef">🕑 ${day}d: ${d}d ${h}h ${m}m</div>
         <div style="color:#f88">💊 Xans: ${data.xan}</div>
         <div style="color:#8f8">🔥 Streak: ${data.streak}d</div>`;
      warn.after(box);
      cache[day] = box;
    }

    wait.style.display = 'block';
    await render(30);
    wait.style.display = 'none';

    sel.onchange = async () => {
      document.querySelectorAll('[class^="dstat-"]').forEach(b => b.remove());
      const d = parseInt(sel.value);
      if (!cache[d]) {
        wait.style.display = 'block';
        await render(d);
        wait.style.display = 'none';
      }
    };
  })();
}
