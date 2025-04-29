// ==UserScript==
// @name         Torn – 30-day Stats (Profile + Search) v1.32
// @namespace    https://www.torn.com/
// @version      1.32
// @description  Show real 30-day time-played, xanax, streak on Profile & Search
// @match        https://www.torn.com/profiles.php?XID=*
// @match        https://www.torn.com/page.php?sid=UserList*
// @match        https://www.torn.com/userlist.php*
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @inject-into  page
// ==/UserScript==

/*──────────────── CONFIG ────────────────*/
const API_KEY   = 'TORN-API-KEY';   // ← your key
const BADGE_RGB = '#c592ff';            // badge colour
const DELAY_MS  = 4500;                 // ms between API calls (search list)
/*════════════════════════════════════════*/

const sleep = ms => new Promise(res => setTimeout(res, ms));

function pick(ps, objPath, arrayName) {
  let v = objPath.reduce((o, k) => o?.[k], ps);
  if (v !== undefined) return v;
  if (Array.isArray(ps)) return (ps.find(e => e.name === arrayName) || {}).value ?? 0;
  return 0;
}

/* fetch 30-day delta snapshot */
const snapshot = xid => new Promise(async ok => {
  const nowUrl = `https://api.torn.com/v2/user/${xid}/personalstats` +
                 `?stat=timeplayed,xantaken,activestreak&key=${API_KEY}`;

  try {
    const nowData = await new Promise((res, rej) =>
      GM_xmlhttpRequest({
        method: 'GET',
        url: nowUrl,
        onload: r => { const j = JSON.parse(r.responseText); j.error ? rej(j.error) : res(j.personalstats); },
        onerror: rej, ontimeout: rej,
      })
    );

    const nowPlay   = pick(nowData, ['other','activity','time'],          'timeplayed');
    const nowXan    = pick(nowData, ['drugs','xanax'],                   'xantaken');
    const nowStreak = pick(nowData, ['other','activity','streak','current'], 'activestreak');

    let oldPlay = nowPlay, oldXan = nowXan, foundDay = 0;

    /* look back 30-35 d for a snapshot */
    for (let offset = 30; offset <= 35; offset++) {
      const ts = Math.floor(Date.now()/1000) - offset*86400;
      const oldUrl = `https://api.torn.com/v2/user/${xid}/personalstats` +
                     `?stat=timeplayed,xantaken,activestreak&timestamp=${ts}&key=${API_KEY}`;
      try {
        const oldData = await new Promise((res, rej) =>
          GM_xmlhttpRequest({
            method: 'GET',
            url: oldUrl,
            onload: r => { const j = JSON.parse(r.responseText); j.error ? rej(j.error) : res(j.personalstats); },
            onerror: rej, ontimeout: rej,
          })
        );
        const tmpPlay = pick(oldData, ['other','activity','time'], 'timeplayed');
        const tmpXan  = pick(oldData, ['drugs','xanax'],            'xantaken');

        if (tmpPlay !== undefined || tmpXan !== undefined) {
          oldPlay = tmpPlay;
          oldXan  = tmpXan;
          foundDay = offset;
          break;
        }
      } catch { /* next offset */ }
    }

    ok({
      play:  Math.max(0, nowPlay - oldPlay),
      xan:   Math.max(0, nowXan  - oldXan),
      streak: nowStreak,
      day:    foundDay || 0,
    });
  } catch {
    ok({ play:0, xan:0, streak:0, day:0 });
  }
});

/* ─── paint badge on a search-list row ─── */
function paint(li, xid, data) {
  const { play, xan, streak, day } = data;
  const d = Math.floor(play / 86400);
  const h = Math.floor(play % 86400 / 3600);
  const m = Math.floor(play % 3600 / 60);

  const span = document.createElement('span');
  span.textContent =
    ` ⏱️${d}d ${h}h ${m}m  💊${xan} 🔥${streak} (${day || 'now'}d)`;
  span.style =
    `font-size:11px;font-weight:600;color:${BADGE_RGB};margin-left:4px;white-space:nowrap;`;

  li.querySelector('span.user-icons')?.appendChild(span);
}
/*════════ PROFILE PAGE ═══════════════════*/
if (location.pathname.startsWith('/profiles.php')) {
  (async () => {
    const XID = new URLSearchParams(location.search).get('XID');
    if (!XID) return;

    const dayOpts = [1, 7, 30];
    const cache   = {};
    const h4      = document.querySelector('.content-title h4');
    if (!h4) return;

    const sel  = Object.assign(document.createElement('select'),
                  { style: 'margin:8px 0;font-size:12px;' });
    dayOpts.forEach(d => sel.innerHTML += `<option>${d}d</option>`);
    sel.value = '30d';
    h4.after(sel);

    const warn = Object.assign(document.createElement('div'),
                  { style: 'font-size:11px;color:orange;display:none;' });
    sel.after(warn);

    const wait = Object.assign(document.createElement('div'),
                  { textContent: 'Loading…', style: 'font-size:11px;color:gray;' });
    warn.after(wait);

    const fetchStat = (stat, ts = null) => new Promise((ok, err) => {
      const url =
        `https://api.torn.com/v2/user/${XID}/personalstats` +
        `?stat=${stat}${ts ? `&timestamp=${ts}` : ''}&key=${API_KEY}`;

      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: r => {
          const j = JSON.parse(r.responseText);
          if (j.error) return err(j.error);
          const ps = j.personalstats;
          const val = pick(ps,
            stat === 'timeplayed'   ? ['other','activity','time']
          : stat === 'activestreak' ? ['other','activity','streak','current']
          : /* xantaken */           ['drugs','xanax'],
            stat);
          ok(val);
        },
        onerror: err,
        ontimeout: err,
      });
    });

    const live = await Promise.all([
      fetchStat('timeplayed'),
      fetchStat('xantaken'),
      fetchStat('activestreak'),
    ]);

    function addBox(day, play, xan, str) {
      const box = document.createElement('div');
      box.className = `dstat-${day}`;
      box.style = 'margin-top:4px;font-size:12px;display:none;row-gap:2px;';
      const d = Math.floor(play / 86400),
            h = Math.floor(play % 86400 / 3600),
            m = Math.floor(play % 3600 / 60);
      box.innerHTML =
        `<div style="color:#8ef">🕑 ${day}d: ${d}d ${h}h ${m}m</div>
         <div style="color:#f88">💊 Xans: ${xan}</div>
         <div style="color:#8f8">🔥 Streak: ${str}d</div>`;
      warn.after(box);
      return box;
    }

    async function render(day) {
      const since = Math.floor(Date.now() / 1000) - day * 86400;
      let oldPlay = await fetchStat('timeplayed', since);
      let oldXan  = await fetchStat('xantaken',  since);

      // 1-day fallback if Torn cached at same second
      if (day === 1 && live[0] === oldPlay) {
        const alt = since - 86400;
        oldPlay = await fetchStat('timeplayed', alt);
        oldXan  = await fetchStat('xantaken',  alt);
        warn.textContent = '📅 Snapshot: ' + new Date(alt * 1e3).toISOString().slice(0, 10);
      }
      cache[day] = addBox(day,
        Math.max(0, live[0] - oldPlay),
        Math.max(0, live[1] - oldXan),
        live[2]);
      if (sel.value === `${day}d`) cache[day].style.display = 'block';
    }

    wait.style.display = 'block';
    await render(30);
    wait.style.display = 'none';

    sel.onchange = async () => {
      document.querySelectorAll('[class^="dstat-"]').forEach(b => (b.style.display = 'none'));
      const d = parseInt(sel.value);
      if (!cache[d]) { wait.style.display = 'block'; await render(d); wait.style.display = 'none'; }
      cache[d].style.display = 'block';
      warn.style.display = d === 1 && warn.textContent ? 'block' : 'none';
    };
  })();
}

/*════════ SEARCH / USERLIST ══════════════*/
if (location.pathname === '/page.php' && location.search.includes('sid=UserList')) {
  const tableWait = setInterval(() => {
    const tbl = document.querySelector('ul.user-info-list-wrap');
    if (!tbl) return;
    clearInterval(tableWait);

    const rowSel  = 'ul.user-info-list-wrap li';
    const nameSel = 'a.user.name[href*="profiles.php?XID="]';

    async function tag(li) {
      if (li.dataset.badged) return;
      li.dataset.badged = '1';

      const xid = li.querySelector(nameSel)?.href.match(/XID=(\d+)/)?.[1];
      if (!xid) return;

      await sleep(DELAY_MS);
      const data = await snapshot(xid);
      paint(li, xid, data);
    }

    tbl.querySelectorAll(rowSel).forEach(tag);

    new MutationObserver(muts => muts.forEach(rec => {
      rec.addedNodes.forEach(n => {
        n.matches?.(rowSel) && tag(n);
        n.querySelectorAll?.(rowSel).forEach(tag);
      });
    })).observe(tbl, { childList:true, subtree:true });
  }, 250);
}
