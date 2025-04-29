// ==UserScript==
// @name         Torn – 30-day Stats (Profile + Search) v1.42
// @namespace    https://www.torn.com/
// @version      1.42
// @description  Shows play-time, xanax and streak on profile pages and user-search lists. Uses a global queue so every Torn-API call is throttled — no more code-5 errors.
// @match        https://www.torn.com/profiles.php?XID=*
// @match        https://www.torn.com/page.php?sid=UserList*
// @match        https://www.torn.com/userlist.php*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @inject-into  page
// ==/UserScript==

/*──────────────────────── CONFIG ───────────────────────*/
const API_KEY  = 'TORN-API-KEY';   //  ←  paste YOUR key here
const BADGE_COLOUR = '#c592ff';        //  violet badge text
const GAP_MS  = 700;                   //  gap between *any* two API calls
/*────────────────────────────────────────────────────────*/

const sleep = ms => new Promise(r => setTimeout(r, ms));

/*──── Global serial queue: guarantees <100 req / min ───*/
let chain = Promise.resolve();
function apiGET(url) {
  chain = chain
    .then(() => sleep(GAP_MS))
    .then(() => new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        onload: r => {
          const j = JSON.parse(r.responseText);
          j.error ? reject(j.error) : resolve(j);
        },
        onerror: reject,
        ontimeout: reject
      });
    }));
  return chain;
}

/*──── Safe extractor for both Torn response shapes ─────*/
function pick(ps, objPath, arrName) {
  let o = ps;
  for (const k of objPath) o = o?.[k];
  if (o !== undefined) return o;
  if (Array.isArray(ps)) return (ps.find(e => e.name === arrName) || {}).value ?? 0;
  return 0;
}

/*─────────────── SEARCH-LIST LOGIC ─────────────────────*/
/* one request per row -> fast, never exceeds limit      */
async function fetchCurrentStats(xid) {
  const url =
    `https://api.torn.com/v2/user/${xid}/personalstats` +
    `?stat=timeplayed,xantaken,activestreak&key=${API_KEY}`;

  const ps = (await apiGET(url)).personalstats;
  return {
    play  : pick(ps, ['other','activity','time'],          'timeplayed'),
    xan   : pick(ps, ['drugs','xanax'],                    'xantaken'),
    streak: pick(ps, ['other','activity','streak','current'], 'activestreak')
  };
}

function paintSearchBadge(li, data) {
  const sec = data.play;
  const d = Math.floor(sec / 86400);
  const h = Math.floor(sec % 86400 / 3600);
  const m = Math.floor(sec % 3600 / 60);

  const span = document.createElement('span');
  span.textContent =
    ` ⏱️${d}d ${h}h ${m}m  💊${data.xan} 🔥${data.streak}`;
  span.style =
    `font-size:11px;font-weight:600;color:${BADGE_COLOUR};` +
    `margin-left:4px;white-space:nowrap;`;
  li.querySelector('span.user-icons')?.appendChild(span);
}

/* activate on /page.php?sid=UserList or /userlist.php */
if ((location.pathname === '/page.php' && location.search.includes('sid=UserList')) ||
     location.pathname === '/userlist.php') {

  const boot = setInterval(() => {
    const ul = document.querySelector('ul.user-info-list-wrap');
    if (!ul) return;
    clearInterval(boot);

    const rowSel = 'ul.user-info-list-wrap li';
    const nameSel = 'a.user.name[href*="profiles.php?XID="]';

    const xidOf = li => li.querySelector(nameSel)?.href.match(/XID=(\d+)/)?.[1] ?? null;

    async function handleRow(li) {
      if (li.dataset.badged) return;
      li.dataset.badged = '1';
      const xid = xidOf(li);
      if (!xid) return;
      const stats = await fetchCurrentStats(xid);
      paintSearchBadge(li, stats);
    }

    ul.querySelectorAll(rowSel).forEach(handleRow);

    new MutationObserver(muts => muts.forEach(rec => {
      rec.addedNodes.forEach(n => {
        if (n.matches?.(rowSel)) handleRow(n);
        n.querySelectorAll?.(rowSel).forEach(handleRow);
      });
    })).observe(ul, { childList:true, subtree:true });
  }, 250);
}

/*─────────────── PROFILE-PAGE LOGIC ────────────────────*/
/* Uses 1 call per stat (same global queue)              */
if (location.pathname.startsWith('/profiles.php')) {
  (async () => {
    const XID = new URLSearchParams(location.search).get('XID');
    if (!XID) return;

    const h4 = document.querySelector('.content-title h4');
    if (!h4) return;

    /* dropdown */
    const sel = document.createElement('select');
    sel.style = 'margin:8px 0;font-size:12px;';
    [1, 7, 30].forEach(d => sel.innerHTML += `<option>${d}d</option>`);
    sel.value = '30d';
    h4.after(sel);

    const warn = Object.assign(document.createElement('div'),
      { style:'font-size:11px;color:orange;display:none;' });
    sel.after(warn);

    const wait = Object.assign(document.createElement('div'),
      { textContent:'Loading…', style:'font-size:11px;color:gray;' });
    warn.after(wait);

    /* helper that fetches a single stat */
    const grab = (stat, ts=null) =>
      apiGET(`https://api.torn.com/v2/user/${XID}/personalstats` +
             `?stat=${stat}${ts?`&timestamp=${ts}`:''}&key=${API_KEY}`)
      .then(r => pick(r.personalstats,
        stat==='timeplayed'   ? ['other','activity','time'] :
        stat==='activestreak' ? ['other','activity','streak','current'] :
                               ['drugs','xanax'],
        stat));

    const live = await Promise.all([
      grab('timeplayed'),
      grab('xantaken'),
      grab('activestreak')
    ]);

    function box(day, play, xan, streak) {
      const div = document.createElement('div');
      div.className = `dstat-${day}`;
      div.style = 'margin-top:4px;font-size:12px;display:none;';
      const d = Math.floor(play/86400),
            h = Math.floor(play%86400/3600),
            m = Math.floor(play%3600/60);
      div.innerHTML =
        `<div style="color:#8ef">🕑 ${day}d: ${d}d ${h}h ${m}m</div>
         <div style="color:#f88">💊 Xans: ${xan}</div>
         <div style="color:#8f8">🔥 Streak: ${streak}d</div>`;
      warn.after(div);
      return div;
    }

    const cache = {};
    async function render(day) {
      const since = Math.floor(Date.now()/1000) - day*86400;
      let oldPlay = await grab('timeplayed', since);
      let oldXan  = await grab('xantaken',  since);

      /* 1-day edge-case fallback */
      if (day === 1 && oldPlay === live[0]) {
        const alt = since-86400;
        oldPlay = await grab('timeplayed', alt);
        oldXan  = await grab('xantaken',  alt);
        warn.textContent = '📅 Snapshot: ' + new Date(alt*1e3).toISOString().slice(0,10);
      }

      cache[day] = box(day,
        Math.max(0, live[0]-oldPlay),
        Math.max(0, live[1]-oldXan),
        live[2]);
      if (sel.value === `${day}d`) cache[day].style.display = 'block';
    }

    wait.style.display = 'block';
    await render(30);
    wait.style.display = 'none';

    sel.addEventListener('change', async () => {
      document.querySelectorAll('[class^="dstat-"]').forEach(d => d.style.display='none');
      const d = parseInt(sel.value);
      if (!cache[d]) { wait.style.display='block'; await render(d); wait.style.display='none'; }
      cache[d].style.display = 'block';
      warn.style.display = (d === 1 && warn.textContent) ? 'block' : 'none';
    });
  })();
}
