// ==UserScript==
// @name         Torn – 30-day Stats (Profile + Search) v1.51
// @namespace    https://www.torn.com/
// @version      1.51
// @description  30-day play-time, xanax & streak on profile pages (instant) and user-search lists (global-throttled)
// @match        https://www.torn.com/profiles.php?XID=*
// @match        https://www.torn.com/page.php?sid=UserList*
// @match        https://www.torn.com/userlist.php*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @inject-into  page
// ==/UserScript==

/*──────── CONFIG ─────────*/
const API_KEY      = 'TORN-API-KEY';   // ← your key
const BADGE_COLOUR = '#c592ff';
const GAP_MS       = 600;                      // search-page gap
/*─────────────────────────*/

const sleep = ms => new Promise(r => setTimeout(r, ms));

/*──────── 1) QUEUED helper (search rows) ───────*/
let lastStart = 0;                     // timestamp of last request start
function queuedGET(url) {
  const now   = Date.now();
  const delay = Math.max(0, lastStart + GAP_MS - now);
  lastStart   = now + delay;

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      directGET(url).then(resolve).catch(reject);
    }, delay);
  });
}


/*──────── 2) DIRECT helper (profile page) ──────*/
function directGET(url) {
  return new Promise((resolve, reject) =>
    GM_xmlhttpRequest({
      method : 'GET',
      url,
      onload : r => {
        const j = JSON.parse(r.responseText);
        j.error ? reject(j.error) : resolve(j);
      },
      onerror : reject,
      ontimeout: reject
    })
  );
}

/*──────── shared picker (nested vs array) ──────*/
function pick(ps, path, arr) {
  let o = ps;
  for (const k of path) o = o?.[k];
  if (o !== undefined) return o;
  if (Array.isArray(ps)) return (ps.find(e => e.name === arr) || {}).value ?? 0;
  return 0;
}

/*──────── 30-day delta snapshot (parallel) ──────*/
async function snapshot30d(xid, getter) {
  const base = `https://api.torn.com/v2/user/${xid}/personalstats?stat=`;
  const nowURL  = base + 'timeplayed,xantaken,activestreak&key=' + API_KEY;
  const ts      = Math.floor(Date.now() / 1000) - 30 * 86400;
  const oldURL  = base + 'timeplayed,xantaken&timestamp=' + ts + '&key=' + API_KEY;

  /* fetch both at once */
  const [nowRes, oldRes] = await Promise.all([
    getter(nowURL).then(r => r.personalstats),
    getter(oldURL).then(r => r.personalstats).catch(() => null)   // tolerate missing history
  ]);

  /* NOW values */
  const nowPlay   = pick(nowRes, ['other','activity','time'],          'timeplayed');
  const nowXan    = pick(nowRes, ['drugs','xanax'],                    'xantaken');
  const nowStreak = pick(nowRes, ['other','activity','streak','current'], 'activestreak');

  /* OLD values (may be null) */
  const oldPlay = oldRes ? pick(oldRes, ['other','activity','time'], 'timeplayed') : nowPlay;
  const oldXan  = oldRes ? pick(oldRes, ['drugs','xanax'],           'xantaken')   : nowXan;

  return {
    play  : Math.max(0, nowPlay - oldPlay),
    xan   : Math.max(0, nowXan  - oldXan),
    streak: nowStreak
  };
}


/*──────── badge painter for search rows (inside icon cell) ─────*/
function paintBadge(li, data) {
  const s = data.play,
        d = Math.floor(s / 86400),
        h = Math.floor(s % 86400 / 3600),
        m = Math.floor(s % 3600 / 60);

  const span = document.createElement('span');
  span.textContent =
    ` ⏱️${d}d ${h}h ${m}m  💊${data.xan} 🔥${data.streak}`;
  span.style =
    'display:inline-block;font-size:11px;font-weight:600;' +
    `color:${BADGE_COLOUR};margin-left:4px;vertical-align:middle;white-space:nowrap;`;

  /* put it *inside* the same TD as the icons */
  const icons = li.querySelector('span.user-icons');
  if (icons) {
    icons.appendChild(span);            // ← back inside the cell
  } else {
    li.appendChild(span);               // fallback for unexpected markup
  }
}


/*════════ SEARCH / USERLIST ═════════════*/
if (
  (location.pathname === '/page.php' && location.search.includes('sid=UserList')) ||
  location.pathname === '/userlist.php'
) {
  const boot = setInterval(() => {
    const ul = document.querySelector('ul.user-info-list-wrap');
    if (!ul) return;
    clearInterval(boot);

    const rowSel  = 'ul.user-info-list-wrap li';
    const nameSel = 'a.user.name[href*="profiles.php?XID="]';

    const xidOf = li => li.querySelector(nameSel)?.href.match(/XID=(\d+)/)?.[1] ?? null;

    async function handleRow(li) {
      if (li.dataset.badged) return;
      li.dataset.badged = '1';
      const xid = xidOf(li);
      if (!xid) return;
      const data = await snapshot30d(xid, queuedGET);  // throttled
      paintBadge(li, data);
    }

    ul.querySelectorAll(rowSel).forEach(handleRow);

    new MutationObserver(m => m.forEach(rec => {
      rec.addedNodes.forEach(n => {
        if (n.matches?.(rowSel)) handleRow(n);
        n.querySelectorAll?.(rowSel).forEach(handleRow);
      });
    })).observe(ul, { childList:true, subtree:true });
  }, 250);
}

/*════════ PROFILE PAGE BOXES ═════════════*/
if (location.pathname.startsWith('/profiles.php')) {
  (async () => {
    const XID = new URLSearchParams(location.search).get('XID');
    if (!XID) return;

    const dayOpts = [1,7,30];
    const cache   = {};
    const h4      = document.querySelector('.content-title h4');
    if (!h4) return;

    const sel = Object.assign(document.createElement('select'),
      { style:'margin:8px 0;font-size:12px;' });
    dayOpts.forEach(d => sel.innerHTML += `<option>${d}d</option>`);
    sel.value = '30d';
    h4.after(sel);

    const warn = Object.assign(document.createElement('div'),
      { style:'font-size:11px;color:orange;display:none;' });
    sel.after(warn);
    const wait = Object.assign(document.createElement('div'),
      { textContent:'Loading…', style:'font-size:11px;color:gray;' });
    warn.after(wait);

    /* unthrottled helper for profile page */
    const fetchStat = (stat, ts=null) =>
      directGET(
        `https://api.torn.com/v2/user/${XID}/personalstats?stat=${stat}` +
        (ts ? `&timestamp=${ts}` : '') + `&key=${API_KEY}`
      ).then(r =>
        pick(
          r.personalstats,
          stat==='timeplayed'   ? ['other','activity','time'] :
          stat==='activestreak' ? ['other','activity','streak','current'] :
          /* xantaken */          ['drugs','xanax'],
          stat
        )
      );

    const live = await Promise.all([
      fetchStat('timeplayed'),
      fetchStat('xantaken'),
      fetchStat('activestreak')
    ]);

    function addBox(day, play, xan, streak) {
      const box = document.createElement('div');
      box.className = `dstat-${day}`;
      box.style = 'margin-top:4px;font-size:12px;display:none;';
      const d = Math.floor(play/86400),
            h = Math.floor(play%86400/3600),
            m = Math.floor(play%3600/60);
      box.innerHTML =
        `<div style="color:#8ef">🕑 ${day}d: ${d}d ${h}h ${m}m</div>
         <div style="color:#f88">💊 Xans: ${xan}</div>
         <div style="color:#8f8">🔥 Streak: ${streak}d</div>`;
      warn.after(box);
      return box;
    }

    async function render(day) {
      const since = Math.floor(Date.now()/1000) - day*86400;
      let oldPlay = await fetchStat('timeplayed', since);
      let oldXan  = await fetchStat('xantaken',  since);

      if (day === 1 && live[0] === oldPlay) {           // cache fallback
        const alt = since - 86400;
        oldPlay = await fetchStat('timeplayed', alt);
        oldXan  = await fetchStat('xantaken',  alt);
        warn.textContent = '📅 Snapshot: ' + new Date(alt*1e3).toISOString().slice(0,10);
      }
      cache[day] = addBox(
        day,
        Math.max(0, live[0]-oldPlay),
        Math.max(0, live[1]-oldXan),
        live[2]
      );
      if (sel.value === `${day}d`) cache[day].style.display='block';
    }

    wait.style.display='block';
    await render(30);
    wait.style.display='none';

    sel.onchange = async () => {
      document.querySelectorAll('[class^="dstat-"]').forEach(b => b.style.display='none');
      const d = parseInt(sel.value);
      if (!cache[d]) { wait.style.display='block'; await render(d); wait.style.display='none'; }
      cache[d].style.display='block';
      warn.style.display = d===1 && warn.textContent ? 'block' : 'none';
    };
  })();
}
