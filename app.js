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
    updatedAt:new Date().toISOString(), news:[], newsCount:0, warnings:[], warningCount:0, earthquakes:[]
  };
}

function render(data){
  const statusEl = $('statusBadge');
  statusEl.textContent = data.dataStatus || (data.mode === 'live' ? 'LIVE' : data.mode?.toUpperCase() || 'UNKNOWN');
  statusEl.className = 'status-badge ' + (data.mode === 'live' ? 'status-live' : 'status-degraded');
  $('updatedAt').textContent = data.updatedAt ? `更新: ${new Date(data.updatedAt).toLocaleTimeString('ja-JP')}` : '';

  renderNews(data.news || [], data.newsCount ?? (data.news||[]).length);
  renderWarnings(data.warnings || [], data.warningCount ?? (data.warnings||[]).length);
  renderQuakes(data.earthquakes || []);

  if(data.sourceError){
    console.warn('Japan Now source issues:', data.sourceError);
  }
}

function renderNews(news, count){
  $('newsCount').textContent = `${count} 件`;
  const el = $('newsList');
  if(!news.length){
    el.innerHTML = '<p class="empty">ニュースを取得できませんでした。しばらくしてから再度お試しください。</p>';
    return;
  }
  el.innerHTML = news.map(n => `
    <a class="news-item" href="${escapeHtml(n.url)}" target="_blank" rel="noopener">
      <span class="news-source">${escapeHtml(n.source)}</span>
      <span class="news-title">${escapeHtml(n.title)}</span>
      <span class="news-time">${escapeHtml(timeAgo(n.published))}</span>
    </a>
  `).join('');
}

function renderWarnings(warnings, count){
  $('warningCount').textContent = `${count} 件`;
  const el = $('warningList');
  if(!warnings.length){
    el.innerHTML = '<p class="empty">現在、アクティブな気象警報・注意報はありません。</p>';
    return;
  }
  el.innerHTML = warnings.map(w => `
    <div class="warning-item">
      <span class="warning-pref">${escapeHtml(w.prefecture)}</span>
      <span class="warning-tags">${w.warnings.map(t=>`<em>${escapeHtml(t)}</em>`).join('')}</span>
    </div>
  `).join('');
}

function renderQuakes(quakes){
  const el = $('quakeList');
  if(!quakes.length){
    el.innerHTML = '<p class="empty">直近の地震・火山情報はありません。</p>';
    return;
  }
  el.innerHTML = quakes.map(q => `
    <a class="quake-item" href="${escapeHtml(q.url || 'https://www.jma.go.jp/')}" target="_blank" rel="noopener">
      <span class="quake-title">${escapeHtml(q.title)}</span>
      ${q.summary ? `<span class="quake-summary">${escapeHtml(q.summary)}</span>` : ''}
      <span class="quake-time">${escapeHtml(timeAgo(q.updated))}</span>
    </a>
  `).join('');
}

loadData();
setInterval(loadData, 60000);
