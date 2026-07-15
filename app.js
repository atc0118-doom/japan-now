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
    updatedAt:new Date().toISOString(), news:[], newsCount:0, newsOk:false,
    regionalNews:[], regionalNewsCount:0,
    warnings:[], warningCount:0, warningsOk:false, earthquakes:[], quakeCount:0, quakesOk:false
  };
}

function render(data){
  const statusEl = $('statusBadge');
  statusEl.textContent = data.dataStatus || (data.mode === 'live' ? 'LIVE' : data.mode?.toUpperCase() || 'UNKNOWN');
  statusEl.className = 'status-badge ' + (data.mode === 'live' ? 'status-live' : 'status-degraded');
  $('updatedAt').textContent = data.updatedAt ? `更新: ${new Date(data.updatedAt).toLocaleTimeString('ja-JP')}` : '';

  renderNews(data.news || [], data.newsCount ?? (data.news||[]).length, data.newsOk !== false);
  renderRegionalNews(data.regionalNews || [], data.regionalNewsCount ?? (data.regionalNews||[]).length, data.newsOk !== false);
  renderWarnings(data.warnings || [], data.warningCount ?? (data.warnings||[]).length, data.warningsOk !== false);
  renderQuakes(data.earthquakes || [], data.quakeCount ?? (data.earthquakes||[]).length, data.quakesOk !== false);

  if(data.sourceError){
    console.warn('Japan Now source issues:', data.sourceError);
  }
}

// FIX: source name and title used to sit side-by-side in a 3-column grid
// (auto 1fr auto). Source names vary a lot in length ("NHK" vs
// "時事ドットコム" vs "TBS NEWS DIG"), and since the source column sized to its
// own content, the title's starting x-position shifted row to row depending
// on how long that row's source name happened to be — titles never lined
// up. Source name + time now sit together on a small line above the title,
// so every title starts at the same left edge regardless of source name
// length. Shared by both renderNews and renderRegionalNews (previously this
// template was duplicated identically in both).
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

// FIX: regional news used to be merged into the main NEWS list, sorted
// purely by publish time. National/political news updates far more
// frequently, so regional stories were successfully fetched but routinely
// pushed out of the display slice before ever being visible. This is its
// own section now, so it isn't competing with national update frequency
// for screen space.
function renderRegionalNews(news, count, ok){
  $('regionalNewsCount').textContent = `${count} 件`;
  const el = $('regionalNewsList');
  if(!news.length){
    el.innerHTML = ok
      ? '<p class="empty">現在、該当する地方の話題はありません。</p>'
      : '<p class="empty error">地方ニュースの取得に失敗しました。しばらくしてから再度お試しください。</p>';
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
  el.innerHTML = warnings.map(w => `
    <div class="warning-item">
      <span class="warning-pref">${escapeHtml(w.prefecture)}</span>
      <span class="warning-tags">${w.warnings.map(t=>`<em>${escapeHtml(t)}</em>`).join('')}</span>
    </div>
  `).join('');
}

function renderQuakes(quakes, count, ok){
  $('quakeCount').textContent = `${count} 件`;
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

loadData();
setInterval(loadData, 60000);
