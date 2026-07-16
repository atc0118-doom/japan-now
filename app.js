function $(id){ return document.getElementById(id); }

function escapeHtml(str=''){
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function timeAgo(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(Number.isNaN(d.getTime())) return '';
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if(mins < 1) return 'たった今';
  if(mins < 60) return `${mins}分前`;
  const hrs = Math.round(mins / 60);
  if(hrs < 24) return `${hrs}時間前`;
  return d.toLocaleDateString('ja-JP', { month:'numeric', day:'numeric' });
}

let currentData = null;

async function loadData(){
  try{
    const res = await fetch('/api/japan');
    const data = await res.json();
    currentData = data;
    render(data);
  }catch(err){
    render(fallbackView(err?.message || 'network error'));
  }
}

function fallbackView(error){
  return {
    ok:true, mode:'fallback', dataStatus:'FALLBACK — 取得失敗', sourceError:error,
    updatedAt:new Date().toISOString(), news:[], newsOk:false,
    warnings:[], warningCount:0, warningsOk:false, earthquakes:[], quakesOk:false
  };
}

function render(data){
  const statusEl = $('statusBadge');
  statusEl.textContent = data.dataStatus || (data.mode === 'live' ? 'LIVE' : data.mode?.toUpperCase() || 'UNKNOWN');
  statusEl.className = 'status-badge ' + (data.mode === 'live' ? 'status-live' : 'status-degraded');
  $('updatedAt').textContent = data.updatedAt ? `更新: ${new Date(data.updatedAt).toLocaleTimeString('ja-JP')}` : '';

  // FIX: news/earthquakes are capped before being sent (30/10 respectively
  // — see api/japan.js), but the count shown next to each heading used to
  // prefer the backend's PRE-cap total. That could show e.g. "113件" while
  // fewer items were actually visible on screen — a real mismatch, not
  // just a rounding quirk. Now the count always reflects what's actually
  // rendered: the array's own length. Warnings is unaffected — that list
  // is never capped, so its count already matched what's shown.
  renderNews(data.news || [], (data.news || []).length, data.newsOk !== false);
  renderWarnings(data.warnings || [], data.warningCount ?? (data.warnings||[]).length, data.warningsOk !== false);
  renderQuakes(data.earthquakes || [], data.quakesOk !== false);

  if(data.sourceError){
    console.warn('Japan Now source issues:', data.sourceError);
  }

  // Content height (especially the warnings list length) can change
  // between refreshes, which shifts where the sidebar should stop
  // sticking — recalculate after the DOM actually updates.
  requestAnimationFrame(updateStickySidebar);
}

// FIX: source name and title used to sit side-by-side in a 3-column grid
// (auto 1fr auto). Source names vary a lot in length ("NHK" vs
// "時事ドットコム" vs "TBS NEWS DIG"), and since the source column sized to its
// own content, the title's starting x-position shifted row to row depending
// on how long that row's source name happened to be — titles never lined
// up. Source name + time now sit together on a small line above the title,
// so every title starts at the same left edge regardless of source name
// length.
function newsItemHtml(n){
  return `
    <a class="news-item" href="${escapeHtml(n.url)}" target="_blank" rel="noopener">
      <div class="news-meta">
        <span class="news-source">${escapeHtml(n.source)}</span>
        <span class="news-time">${escapeHtml(timeAgo(n.published))}</span>
      </div>
      <span class="news-title">${escapeHtml(n.title)}</span>
    </a>
  `;
}

function renderNews(news, count, ok){
  $('newsCount').textContent = `${count} 件`;
  const el = $('newsList');
  if(!news.length){
    el.innerHTML = ok
      ? '<p class="empty">現在、該当するニュースはありません。</p>'
      : '<p class="empty error">ニュースの取得に失敗しました。しばらくしてから再度お試しください。</p>';
    return;
  }
  el.innerHTML = news.map(newsItemHtml).join('');
}

function renderWarnings(warnings, count, ok){
  // FIX: this used to say "N 件", which reads like "N warnings" — but N is
  // actually a count of PREFECTURES with at least one active warning, not
  // the total number of warning types (Tokyo alone can show 4 different
  // warning types under a single count). "都道府県" makes the count's
  // actual meaning clear without needing to read the paragraph below it.
  $('warningCount').textContent = `${count} 都道府県`;
  const el = $('warningList');
  if(!warnings.length){
    // FIX: previously this always showed "no active warnings" whenever the
    // list was empty, regardless of WHY it was empty. A genuinely empty
    // list (fetch succeeded, nothing active) and a failed fetch (unknown
    // status) are very different claims for a weather-warning display to
    // make — conflating them meant a total JMA fetch failure would still
    // confidently tell the user everything's clear.
    el.innerHTML = ok
      ? '<p class="empty">現在、アクティブな気象警報・注意報はありません。</p>'
      : '<p class="empty error">警報・注意報の取得に失敗しました。安全のため、気象庁の公式情報を直接ご確認ください。</p>';
    return;
  }
  el.innerHTML = warnings.map(w => {
    // FIX: these were plain <div>s with no way to see more detail — tapping
    // did nothing. JMA's own warning page supports deep-linking to a
    // specific area via "#area_type=offices&area_code={code}" (confirmed
    // against JMA's own forecast/warning pages, not guessed). For grouped
    // rows (Hokkaido/Okinawa collapse several offices under one label — see
    // groupWarningsByPrefecture), `code` is a comma-joined list; the first
    // code is used as a representative link, since JMA's URL scheme only
    // targets one area at a time.
    const firstCode = String(w.code || '').split(',')[0];
    const url = firstCode ? `https://www.jma.go.jp/bosai/warning/#area_type=offices&area_code=${encodeURIComponent(firstCode)}` : 'https://www.jma.go.jp/bosai/warning/';
    return `
    <a class="warning-item" href="${escapeHtml(url)}" target="_blank" rel="noopener">
      <span class="warning-pref">${escapeHtml(w.prefecture)}</span>
      <span class="warning-tags">${w.warnings.map(t=>`<em>${escapeHtml(t)}</em>`).join('')}</span>
    </a>
  `;
  }).join('');
}

function renderQuakes(quakes, ok){
  // FIX: count is now derived from the array actually being rendered
  // (already capped to 10 by the backend), filtered to exclude routine
  // bulletins — this satisfies both the "count matches what's visible"
  // fix and the earlier "定時 bulletins shouldn't inflate the count" fix at
  // the same time, since both operate on the same already-sliced list.
  const genuineCount = quakes.filter(q => !q.isRoutine).length;
  $('quakeCount').textContent = `${genuineCount} 件`;
  const el = $('quakeList');
  if(!quakes.length){
    el.innerHTML = ok
      ? '<p class="empty">直近の地震・火山情報はありません。</p>'
      : '<p class="empty error">地震・火山情報の取得に失敗しました。気象庁の公式情報を直接ご確認ください。</p>';
    return;
  }
  el.innerHTML = quakes.map(q => `
    <a class="quake-item" href="${escapeHtml(q.url || 'https://www.jma.go.jp/')}" target="_blank" rel="noopener">
      <span class="quake-title">${q.isRoutine ? '<em class="routine-tag">定時</em> ' : ''}${escapeHtml(q.title)}</span>
      ${q.summary ? `<span class="quake-summary">${escapeHtml(q.summary)}</span>` : ''}
      <span class="quake-time">${escapeHtml(timeAgo(q.updated))}</span>
    </a>
  `).join('');
}

// FIX: CSS `position:sticky` for the right column was tried twice (first
// inside CSS Grid, then inside Flexbox after the Grid version showed the
// same symptom) — a screen recording showed the sidebar scroll normally at
// first, then partway down the page suddenly jump BACKWARD to earlier
// content instead of properly detaching once at the very bottom, in both
// layouts. Rather than guess at a third CSS-only fix, this measures scroll
// position directly and sets the sidebar's position explicitly on every
// scroll tick — there's no CSS sticky/containing-block mechanism left that
// could behave unpredictably, since nothing is delegated to the browser's
// own sticky implementation at all.
const STICKY_BREAKPOINT = 900;
const STICKY_OFFSET = 20;
const STICKY_GAP = 20;
let stickySideWidth = 0, stickyMainWidth = 0;

function resetStickySidebar(side, main){
  side.style.position = '';
  side.style.top = '';
  side.style.left = '';
  side.style.width = '';
  main.style.width = '';
}

function updateStickySidebar(){
  const side = document.querySelector('.col-side');
  const main = document.querySelector('.col-main');
  const grid = document.querySelector('.dashboard-grid');
  if(!side || !main || !grid) return;

  if(window.innerWidth < STICKY_BREAKPOINT){
    resetStickySidebar(side, main);
    return;
  }

  // Only recapture natural widths while the sidebar is in normal document
  // flow — once it's fixed/absolute its own width is whatever we set it
  // to, not its natural flex-computed width, so capturing at that point
  // would just lock in a stale value.
  if(side.style.position !== 'fixed' && side.style.position !== 'absolute'){
    stickySideWidth = side.getBoundingClientRect().width;
    stickyMainWidth = main.getBoundingClientRect().width;
  }
  if(!stickySideWidth || !stickyMainWidth) return; // not laid out yet

  const gridRect = grid.getBoundingClientRect();
  const scrollY = window.scrollY;
  const gridTop = gridRect.top + scrollY;
  const gridHeight = grid.offsetHeight;
  const sideHeight = side.offsetHeight;
  const stickyStart = gridTop - STICKY_OFFSET;
  const stickyEnd = gridTop + gridHeight - sideHeight - STICKY_OFFSET;

  main.style.width = stickyMainWidth + 'px';
  side.style.width = stickySideWidth + 'px';

  if(scrollY <= stickyStart || stickyEnd <= stickyStart){
    // Grid hasn't scrolled far enough yet, or the sidebar is already taller
    // than the grid (nothing to stick within) — stay in normal flow.
    side.style.position = '';
    side.style.top = '';
    side.style.left = '';
  } else if(scrollY >= stickyEnd){
    // Reached the bottom of the grid: stop following the viewport and pin
    // to the bottom of the grid instead, so it doesn't run past the end of
    // the news column.
    side.style.position = 'absolute';
    side.style.top = (gridHeight - sideHeight) + 'px';
    side.style.left = (stickyMainWidth + STICKY_GAP) + 'px';
  } else {
    side.style.position = 'fixed';
    side.style.top = STICKY_OFFSET + 'px';
    side.style.left = (gridRect.left + stickyMainWidth + STICKY_GAP) + 'px';
  }
}

function initStickySidebar(){
  window.addEventListener('scroll', updateStickySidebar, { passive:true });
  window.addEventListener('resize', () => {
    const side = document.querySelector('.col-side');
    const main = document.querySelector('.col-main');
    if(side && main) resetStickySidebar(side, main);
    requestAnimationFrame(updateStickySidebar);
  });
  updateStickySidebar();
}

initStickySidebar();
loadData();
setInterval(loadData, 60000);
