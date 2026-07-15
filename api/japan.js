// JAPAN NOW — "what's happening in Japan right now" data aggregator
//
// DESIGN NOTE (intentional, discussed before writing any code): this is NOT
// a risk index. There is no score, no weighting, no "Global Risk Index"
// concept here. That model made sense for ORACLE's geopolitical-conflict
// focus, but "what's happening in Japan today" is a broader, more neutral
// question — news, weather warnings, and earthquakes are not "risk points"
// to add up, they're just categorized facts. This endpoint's job is to
// fetch, categorize, and honestly label its own limitations — not to score.
//
// SOURCES (verified before writing this, not assumed):
// - NHK NEWS WEB RSS: https://news.web.nhk/n-data/conf/na/rss/cat0.xml
//   (NHK migrated RSS URLs at some point; this is the current live one as of
//   this writing — confirmed by fetching it directly.)
// - Google News (Japan edition): same RSS mechanism ORACLE already uses,
//   just with hl=ja&gl=JP&ceid=JP:ja instead of the English params.
// - Yahoo!ニュース RSS is NOT used here. Their RSS terms explicitly prohibit
//   building a website or application with it ("これを使ったサイト/アプリの公開を
//   許可しておりません"). Using it here would violate their terms, full stop.
// - JMA (気象庁) warnings/advisories: https://www.jma.go.jp/bosai/warning/data/warning/{code}.json
//   Not an official supported API (it's JSON JMA happens to publish for
//   their own site), so it could change without notice — treated as
//   degradable, same as GDELT/Guardian in ORACLE.
// - JMA area codes: https://www.jma.go.jp/bosai/common/const/area.json
//   fetched at runtime rather than hardcoded, specifically to avoid
//   transcription errors from manually typing ~54 area codes — this is the
//   same authoritative source JMA's own site uses to build its region list.
// - JMA earthquake/volcano feed (official, PULL-type, Atom):
//   https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml
//
// JMA explicitly warns that IPs downloading >10GB/day get blocked. Response
// bodies here are small JSON/XML, but this is still why everything is
// cached (10 min, same TTL philosophy as ORACLE) rather than fetched fresh
// on every request.

const CACHE_TTL_MS = 10 * 60 * 1000;
const AREA_CODES_TTL_MS = 24 * 60 * 60 * 1000; // area codes barely ever change
const FETCH_TIMEOUT_MS = 6500;

const NHK_RSS_URL = 'https://news.web.nhk/n-data/conf/na/rss/cat0.xml';
// FIX: this used to hit the generic Japan top-stories feed
// (news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja), which mixes in whatever
// Google's algorithm considers "top" for the day — including tech/gadget
// leaks (Pixel phones), gaming news, and generic world science stories that
// have nothing to do with "what's happening in Japan" specifically. Google
// News does have topic/section-specific RSS URLs (e.g. a "国内"/NATION
// section), but that URL scheme couldn't be verified live from here, so
// rather than guess at an unverified endpoint, this uses the same
// query-based RSS mechanism ORACLE's own global version already relies on
// successfully — narrowed to domestic politics/government/economy/society/
// disaster keywords, which is what actually distinguishes "Japan news" from
// "tech news that happens to be in Japanese".
const GOOGLE_NEWS_JP_QUERY = encodeURIComponent('(国会 OR 内閣 OR 首相 OR 与党 OR 野党 OR 政府 OR 経済対策 OR 日銀 OR 選挙 OR 災害 OR 地震 OR 台風 OR 大雨 OR 事件 OR 事故 OR 感染症 OR 皇室)');
const GOOGLE_NEWS_JP_URL = `https://news.google.com/rss/search?q=${GOOGLE_NEWS_JP_QUERY}&hl=ja&gl=JP&ceid=JP:ja`;

// FIX: the query above is purely national-politics/government-focused, so
// genuinely local stories (a town's festival, a prefectural assembly
// decision, a regional business story) never matched it — the news list was
// effectively "national news, reported redundantly by many different local
// affiliates" rather than actual regional news. NHK does have a real local
// news section ("地域ニュース"), but it sits behind a "ご利用意向の確認"
// (usage-agreement) gate on their NHK ONE platform — a meaningfully
// different signal than the plain RSS feed used elsewhere here, so it's
// deliberately not scraped. This is the safer alternative: a SEPARATE
// Google News query using all 47 prefecture names, kept as its own request
// (rather than merged into the query above) so the URL doesn't balloon past
// a reasonable length with 60+ OR terms in one query.
const GOOGLE_NEWS_JP_REGIONAL_QUERY = encodeURIComponent('(北海道 OR 青森県 OR 岩手県 OR 宮城県 OR 秋田県 OR 山形県 OR 福島県 OR 茨城県 OR 栃木県 OR 群馬県 OR 埼玉県 OR 千葉県 OR 東京都 OR 神奈川県 OR 新潟県 OR 富山県 OR 石川県 OR 福井県 OR 山梨県 OR 長野県 OR 岐阜県 OR 静岡県 OR 愛知県 OR 三重県 OR 滋賀県 OR 京都府 OR 大阪府 OR 兵庫県 OR 奈良県 OR 和歌山県 OR 鳥取県 OR 島根県 OR 岡山県 OR 広島県 OR 山口県 OR 徳島県 OR 香川県 OR 愛媛県 OR 高知県 OR 福岡県 OR 佐賀県 OR 長崎県 OR 熊本県 OR 大分県 OR 宮崎県 OR 鹿児島県 OR 沖縄県)');
const GOOGLE_NEWS_JP_REGIONAL_URL = `https://news.google.com/rss/search?q=${GOOGLE_NEWS_JP_REGIONAL_QUERY}&hl=ja&gl=JP&ceid=JP:ja`;

const JMA_AREA_JSON_URL = 'https://www.jma.go.jp/bosai/common/const/area.json';
const JMA_WARNING_BASE = 'https://www.jma.go.jp/bosai/warning/data/warning/';
const JMA_EQVOL_FEED_URL = 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml';

const CACHE = globalThis.__JAPAN_NOW_CACHE__ || (globalThis.__JAPAN_NOW_CACHE__ = {
  payload: null, ts: 0, areaOffices: null, areaTs: 0
});

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=240');

  try{
    const now = Date.now();
    if(CACHE.payload && now - CACHE.ts < CACHE_TTL_MS){
      return res.status(200).json(CACHE.payload);
    }

    const payload = await buildPayload();
    CACHE.payload = payload;
    CACHE.ts = Date.now();
    res.status(200).json(payload);
  }catch(error){
    res.status(200).json(fallbackPayload(error?.message || 'unknown'));
  }
}

// Same retry-with-timeout pattern as ORACLE's fetchWithTimeout: one quick
// retry on a transient failure before giving up on that source for this
// cycle, so a single network blip doesn't take a whole category offline.
async function fetchWithTimeout(url, options={}){
  const attempts = options.retries ?? 1;
  let lastErr;
  for(let attempt = 0; attempt <= attempts; attempt++){
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), options.timeout || FETCH_TIMEOUT_MS);
    try{
      return await fetch(url, { ...options, signal:controller.signal });
    }catch(err){
      lastErr = err;
      if(attempt < attempts) await new Promise(r=>setTimeout(r, 250));
    }finally{
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

async function buildPayload(){
  const [newsResult, warningsResult, quakesResult] = await Promise.allSettled([
    fetchAllNews(),
    fetchAllWarnings(),
    fetchEarthquakes()
  ]);

  const news = newsResult.status === 'fulfilled' ? newsResult.value.items : [];
  const newsReport = newsResult.status === 'fulfilled' ? newsResult.value.report : [{ name:'News', ok:false, error: newsResult.reason?.message || 'error' }];

  const warnings = warningsResult.status === 'fulfilled' ? warningsResult.value.items : [];
  const warningsError = warningsResult.status === 'rejected' ? (warningsResult.reason?.message || 'error') : (warningsResult.value?.error || null);

  const quakes = quakesResult.status === 'fulfilled' ? quakesResult.value : [];
  const quakesError = quakesResult.status === 'rejected' ? (quakesResult.reason?.message || 'error') : null;

  const failedSources = [
    ...newsReport.filter(r=>!r.ok).map(r=>`${r.name} ${r.error}`),
    ...(warningsError ? [`JMA warnings ${warningsError}`] : []),
    ...(quakesError ? [`JMA earthquakes ${quakesError}`] : [])
  ];

  const anyLiveNews = news.length > 0;
  const anyLiveDisaster = warnings.length > 0 || quakes.length > 0 || (warningsResult.status === 'fulfilled' && !warningsError);
  // FIX (honesty, same principle as ORACLE): if literally nothing came back
  // from any source, say so plainly rather than showing an empty dashboard
  // that just looks quiet. An empty warnings list legitimately means "no
  // active warnings right now" (that's real, good news) — but total fetch
  // failure across every source is a different, distinguishable situation.
  const isDegraded = !anyLiveNews && !anyLiveDisaster;

  // FIX: this top-level isDegraded flag only catches the case where EVERY
  // source failed at once. It's entirely possible for news to succeed while
  // warnings specifically fail (e.g. >50% of JMA offices unreachable) — in
  // that case `mode` would still say 'live' (because news came through),
  // giving the frontend no way to know warnings/earthquakes specifically
  // failed. The frontend's renderWarnings/renderQuakes were using this gap
  // to render "現在、アクティブな警報はありません" (no active warnings) even when
  // the real situation was "we don't know, the fetch failed" — a
  // meaningfully different and more dangerous claim for a page whose whole
  // point is showing active warnings. These per-category flags close that
  // gap; each section can now tell the two situations apart independently.
  const newsOk = newsReport.some(r => r.ok);
  const warningsOk = !warningsError;
  const quakesOk = !quakesError;

  return {
    ok: true,
    mode: isDegraded ? 'degraded' : 'live',
    dataStatus: isDegraded ? 'DEGRADED — sources unreachable' : 'LIVE',
    sourceError: failedSources.length ? failedSources.join(' · ') : null,
    updatedAt: new Date().toISOString(),
    cacheTtlMinutes: Math.round(CACHE_TTL_MS / 60000),
    news: news.slice(0, 30),
    newsCount: news.length,
    newsOk,
    warnings, // only prefectures with an ACTIVE warning/advisory right now — see fetchAllWarnings
    warningCount: warnings.length,
    warningsOk,
    earthquakes: quakes.slice(0, 10),
    // FIX: this used to count ALL entries (urgent + routine bulletins), so
    // a quiet day with 8 volcanoes under routine "定時" ashfall watch and
    // just 1 real earthquake report would show "9 件" — giving the opposite
    // impression of the "urgent info first" fix applied earlier. The header
    // count now reflects only genuine events (matching what "定時"-tagged
    // items are NOT), since that's what a count next to "地震・火山情報" should
    // mean — not "how many bulletins exist right now".
    quakeCount: quakes.filter(q => !q.isRoutine).length,
    quakesOk,
    sourceReport: [
      ...newsReport,
      { name:'JMA Warnings', ok: warningsOk, error: warningsError || undefined },
      { name:'JMA Earthquakes', ok: quakesOk, error: quakesError || undefined }
    ]
  };
}

// ---- News ----

async function fetchAllNews(){
  const collectors = [
    ['NHK', fetchNHKNews],
    ['Google News (Japan)', fetchGoogleNewsJP],
    ['Google News (地域)', async () => (await fetchGoogleNewsJPRegional()).slice(0, 15)]
  ];
  const settled = await Promise.allSettled(collectors.map(async ([name, fn])=>{
    const items = await fn();
    return { name, ok:true, count: items.length, items };
  }));
  const report = settled.map((r,i)=>{
    const name = collectors[i][0];
    if(r.status === 'fulfilled') return { name, ok:true, count:r.value.count };
    return { name, ok:false, count:0, error: r.reason?.message || 'error' };
  });
  let items = [];
  for(const r of settled){ if(r.status === 'fulfilled') items.push(...r.value.items); }
  items = dedupeByTitleStem(items).sort((a,b)=> new Date(b.published||0) - new Date(a.published||0));
  return { items, report };
}

async function fetchNHKNews(){
  const r = await fetchWithTimeout(NHK_RSS_URL, { headers:{ 'user-agent':'JapanNow/1.0' } });
  if(!r.ok) throw new Error('nhk ' + r.status);
  const xml = await r.text();
  return parseRss(xml, 'NHK');
}

async function fetchGoogleNewsJP(){
  const r = await fetchWithTimeout(GOOGLE_NEWS_JP_URL, { headers:{ 'user-agent':'JapanNow/1.0' } });
  if(!r.ok) throw new Error('google_news_jp ' + r.status);
  const xml = await r.text();
  return parseRss(xml, 'Google News');
}

async function fetchGoogleNewsJPRegional(){
  const r = await fetchWithTimeout(GOOGLE_NEWS_JP_REGIONAL_URL, { headers:{ 'user-agent':'JapanNow/1.0' } });
  if(!r.ok) throw new Error('google_news_jp_regional ' + r.status);
  const xml = await r.text();
  return parseRss(xml, 'Google News');
}

function parseRss(xml, fallbackSource='RSS'){
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>m[1]);
  return items.map(block=>{
    // FIX: outlet-name suffixes on the end of a headline have shown up in
    // three different forms so far, each fixed as discovered — a hyphen or
    // (ASCII/fullwidth) pipe separator ("- Outlet" / "| Outlet" / "｜ Outlet"),
    // and a trailing parenthetical containing a broadcaster network code
    // (bare "(NNN)" or mixed with the outlet name like "（日テレNEWS NNN）").
    // Other separator styles may still exist that aren't covered here.
    const rawTitle = decodeXml((block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)?.[1] || block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ''));
    const title = clean(rawTitle
      // FIX: the general suffix-stripper below requires the trailing content
      // to contain NO hyphens (`[^-|｜]+$`), which breaks when the outlet
      // itself is a domain name containing a hyphen (e.g.
      // "...備えー「耐震」と「免震」は違うもの - fukuoka-u.ac.jp" — "fukuoka-u.ac.jp"
      // has a hyphen in "fukuoka-u", so the general pattern never matched
      // and the domain suffix stayed attached). This runs first and
      // specifically targets a trailing "- domain.tld" / "| domain.tld"
      // shape regardless of hyphens inside the domain, since a real
      // headline essentially never legitimately ends in a literal domain
      // name.
      .replace(/\s+[-|｜]\s+[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/,'')
      .replace(/\s+[-|｜]\s+[^-|｜]+$/,'')
      // FIX: both patterns above require whitespace on BOTH sides of the
      // separator. That broke when an outlet omitted the space on one or
      // both sides of a pipe (e.g. "...掲載）|日テレNEWS NNN" or
      // "...掲載） |日テレNEWS NNN") — confirmed by observing the exact same
      // underlying story appear twice in the feed, once correctly stripped
      // and once not. Pipes (ASCII "|" or fullwidth "｜") essentially never
      // appear in ordinary Japanese sentence content the way a hyphen might
      // (e.g. inside "J-POP" or a compound term), so it's safe to strip a
      // trailing pipe-separated suffix regardless of surrounding whitespace
      // — unlike the hyphen case above, which still requires whitespace on
      // both sides to avoid mistaking a real mid-sentence hyphen for a
      // separator.
      .replace(/\s*[|｜]\s*[^-|｜]+$/,'')
      .replace(/[(（][^()（）]{0,20}(NNN|JNN|FNN|ANN|TXN)[^()（）]{0,20}[)）]\s*$/,'')
    ).slice(0, 120);
    const url = decodeXml(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '');
    const source = decodeXml(block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || fallbackSource);
    const pub = decodeXml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '');
    return { title, url, source: clean(source) || fallbackSource, published: pub };
  }).filter(a => a.title && a.url && !isGarbageTitle(a.title));
}

// FIX: some smaller/less-standardized sites feed Google News malformed or
// incomplete metadata, and a literal placeholder string like "og_description"
// (an Open Graph meta-tag NAME, not real content) leaks into the title —
// sometimes standing alone, sometimes appended after legitimate-looking text
// (the actual reported case was "レバンガ北海道 og_description", not just the
// bare token). Either way, if a title ends with one of these known
// placeholder tokens, the whole thing is unreliable — there's no way to
// confirm the preceding text was really a standalone headline versus a page
// title that happened to include a team/organization name — so it's
// filtered out entirely rather than trimmed and kept.
const GARBAGE_TITLE_SUFFIX = /(^|\s)(og_description|og:description|undefined|null|no title|untitled)$/i;
function isGarbageTitle(title){
  return GARBAGE_TITLE_SUFFIX.test(String(title || '').trim());
}

function decodeXml(s=''){
  // FIX: this only handled the five core XML entities (amp/lt/gt/quot/#39).
  // Confirmed root cause of a persistent bug: some titles use a literal
  // "&nbsp;" (or its numeric form "&#160;") as the space around a separator
  // instead of a real whitespace character. Left undecoded, "&nbsp;" is 6
  // literal characters — not whitespace — so the title-cleanup regex's \s+
  // requirement around the separator never matched, and the outlet-name
  // suffix was never stripped at all. Confirmed by reproducing the exact
  // failure with a constructed "&nbsp;|&nbsp;" separator before this fix.
  return String(s)
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&nbsp;/g,' ').replace(/&#160;/g,' ');
}
function clean(s=''){ return String(s).replace(/\s+/g,' ').trim(); }

function dedupeByTitleStem(items){
  // FIX: this originally split the cleaned title on spaces and took the
  // first 10 "words" (the same approach ORACLE uses for English headlines).
  // Japanese text has no spaces between words at all, so splitting on ' '
  // just returns the entire string as a single element — meaning the "stem"
  // was actually the WHOLE title, not a meaningful prefix, and two headlines
  // sharing an opening but differing later (a very common RSS pattern —
  // outlets append "、詳細は" or similar) never matched as duplicates. Using a
  // fixed character-count prefix instead works for both English and
  // Japanese without needing a real tokenizer (which isn't available here).
  const seen = new Set();
  const out = [];
  for(const a of items){
    const normalized = clean(a.title).toLowerCase().replace(/[^a-z0-9ぁ-んァ-ヶ一-龠]+/g,'');
    const key = normalized.slice(0, 24);
    if(!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

// ---- Disaster / weather warnings ----

async function fetchJMAOffices(){
  const now = Date.now();
  if(CACHE.areaOffices && now - CACHE.areaTs < AREA_CODES_TTL_MS){
    return CACHE.areaOffices;
  }
  const r = await fetchWithTimeout(JMA_AREA_JSON_URL, { headers:{ 'user-agent':'JapanNow/1.0' } });
  if(!r.ok) throw new Error('jma_area ' + r.status);
  const j = await r.json();

  // FIX: previously this was just Object.entries(j.offices), which returns
  // whatever incidental key order the JSON happened to use — not a
  // geographic order. area.json's `centers` object already IS ordered
  // north-to-south (010100 Hokkaido -> 010200 Tohoku -> 010300 Kanto Koshin
  // -> ... -> 011100 Okinawa), and each center lists its member offices in
  // `children`. Walking centers in their given order, then each center's
  // children in their given order, produces a natural Hokkaido -> Okinawa
  // sequence for free, using data JMA itself already sequenced this way —
  // no separate prefecture-order table to maintain or get wrong.
  const centers = j.centers || {};
  const officesById = j.offices || {};
  const orderedCodes = [];
  for(const center of Object.values(centers)){
    for(const code of (center.children || [])){
      if(officesById[code] && !orderedCodes.includes(code)) orderedCodes.push(code);
    }
  }
  // Any office not reachable via a center's children (shouldn't normally
  // happen, but better to include it at the end than silently drop it).
  for(const code of Object.keys(officesById)){
    if(!orderedCodes.includes(code)) orderedCodes.push(code);
  }

  const offices = orderedCodes.map(code=>({ code, name: officesById[code].name }));
  CACHE.areaOffices = offices;
  CACHE.areaTs = now;
  return offices;
}

// FIX (all-47 coverage, done right): rather than a hand-typed table of 47
// prefecture codes (real risk of typos silently dropping a prefecture),
// this walks the actual `offices` list JMA's own site uses — which is ~54
// entries, since Hokkaido, Kagoshima (Amami split out), and Okinawa are
// each split into multiple forecast/warning offices rather than one code
// per prefecture. Together these DO cover all 47 prefectures; there just
// isn't a clean 1:1 code-to-prefecture mapping for a few of them.

// FIX (display grouping): JMA's own warning granularity splits Hokkaido into
// 8 separate offices and Okinawa into 4, so those two showed up as 8 and 4
// separate rows respectively while every other prefecture showed as exactly
// one row — a jarring inconsistency once you're looking at the whole list.
// These codes are copied directly from the actual area.json response
// fetched earlier while building this (not reconstructed from memory), so
// there's no transcription-error risk the way a hand-typed 47-row table
// would carry. Kagoshima's Amami split (460040/460100) is deliberately left
// alone: Amami is genuinely a separate, distant island chain with materially
// different weather, so collapsing it into "Kagoshima" would hide real
// information rather than just tidying up a display quirk.
const PREFECTURE_GROUP_LABELS = {
  '011000':'北海道','012000':'北海道','013000':'北海道','014030':'北海道',
  '014100':'北海道','015000':'北海道','016000':'北海道','017000':'北海道',
  '471000':'沖縄県','472000':'沖縄県','473000':'沖縄県','474000':'沖縄県'
};

async function fetchAllWarnings(){
  const offices = await fetchJMAOffices();
  const settled = await Promise.allSettled(offices.map(async (office)=>{
    const r = await fetchWithTimeout(JMA_WARNING_BASE + office.code + '.json', { headers:{ 'user-agent':'JapanNow/1.0' }, timeout: 5000 });
    if(!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    return { office, data: j };
  }));

  let failCount = 0;
  const officeResults = [];
  for(const r of settled){
    if(r.status !== 'fulfilled'){ failCount++; continue; }
    const { office, data } = r.value;
    officeResults.push({ office, warnings: extractActiveWarningNames(data) });
  }
  const active = groupWarningsByPrefecture(officeResults);

  // If most offices failed to respond, treat the whole warnings pull as
  // degraded rather than confidently reporting "no active warnings" —
  // those aren't the same thing, and conflating them would be exactly the
  // kind of silent dishonesty ORACLE spent a lot of effort avoiding.
  const error = failCount > offices.length * 0.5 ? `${failCount}/${offices.length} offices unreachable` : null;
  return { items: active, error };
}

// Pulled out as its own function (rather than inlined in fetchAllWarnings)
// specifically so it can be unit-tested without mocking network calls — see
// tests/japan.test.mjs. Input is expected to already be in north-to-south
// office order (as fetchJMAOffices produces); a Map preserves insertion
// order, so the first time a display label is seen determines its position
// in the output.
function groupWarningsByPrefecture(officeResults){
  const grouped = new Map();
  for(const { office, warnings } of officeResults){
    if(!warnings || !warnings.length) continue;
    const label = PREFECTURE_GROUP_LABELS[office.code] || office.name;
    if(!grouped.has(label)) grouped.set(label, { prefecture: label, codes: [], warnings: new Set() });
    const entry = grouped.get(label);
    entry.codes.push(office.code);
    warnings.forEach(w => entry.warnings.add(w));
  }
  return [...grouped.values()].map(g => ({ prefecture: g.prefecture, code: g.codes.join(','), warnings: [...g.warnings] }));
}

// FIX: this was originally written assuming a `{name, status}` shape based
// on general research, but fetching a REAL live response
// (jma.go.jp/bosai/warning/data/warning/130000.json) while testing this
// revealed the actual schema uses `{code, status}` — there is no `name`
// field anywhere in the real data. The original version would have matched
// nothing, ever, and silently reported zero active warnings on every single
// request — exactly the kind of quiet failure this whole project has been
// trying to design against. This code table was cross-checked two ways
// before use: (1) against a source explicitly updated for the 2026-05-29
// JMA schema change, and (2) against the `type` labels JMA's own response
// uses internally (e.g. code 14's entries are labelled "雷危険度", code 20's
// are labelled "濃霧危険度", etc. — those matched this table exactly).
const JMA_WARNING_CODE_NAMES = {
  '02':'暴風雪警報','03':'大雨警報','04':'洪水警報','05':'暴風警報','06':'大雪警報',
  '07':'波浪警報','08':'高潮警報','09':'土砂災害警報','10':'大雨注意報','12':'大雪注意報',
  '13':'風雪注意報','14':'雷注意報','15':'強風注意報','16':'波浪注意報','17':'融雪注意報',
  '18':'洪水注意報','19':'高潮注意報','20':'濃霧注意報','21':'乾燥注意報','22':'なだれ注意報',
  '23':'低温注意報','24':'霜注意報','25':'着氷注意報','26':'着雪注意報','29':'土砂災害注意報',
  '32':'暴風雪特別警報','33':'大雨特別警報','35':'暴風特別警報','36':'大雪特別警報',
  '37':'波浪特別警報','38':'高潮特別警報','39':'土砂災害特別警報','43':'大雨危険警報',
  '48':'高潮危険警報','49':'土砂災害危険警報'
};

function extractActiveWarningNames(data){
  const names = new Set();
  const walk = (node) => {
    if(!node || typeof node !== 'object') return;
    if(Array.isArray(node)){ node.forEach(walk); return; }
    // A real warning entry looks like {"code":"14","status":"継続"}. The
    // "no warnings" case is {"status":"発表警報・注意報はなし"} (no code field at
    // all), and cleared warnings are {"code":"...","status":"解除"} — both
    // are correctly excluded here since we require BOTH a code AND a status
    // that isn't "解除".
    if(typeof node.code === 'string' && typeof node.status === 'string' && node.status !== '解除'){
      names.add(JMA_WARNING_CODE_NAMES[node.code] || `警報コード${node.code}`);
    }
    Object.values(node).forEach(walk);
  };
  walk(data);
  return [...names];
}

// ---- Earthquakes / volcanoes ----

// FIX: this used to just take the 10 most recent entries from the combined
// earthquake+volcano feed, sorted purely by time. In practice, JMA issues
// routine "降灰予報（定時）" (scheduled ashfall forecast) bulletins for every
// volcano currently under any watch level, on a recurring schedule,
// regardless of whether anything is actually happening. When several
// volcanoes are under watch at once, these routine bulletins can fill all
// 10 slots by themselves — meaning an actual earthquake report from
// slightly earlier could be pushed out and never shown at all, on a section
// literally titled "地震・火山情報". JMA's own naming convention already
// distinguishes "定時" (scheduled/routine) from other report types (e.g.
// 震度速報, 地震情報, 噴火速報, 噴火警報) — using that distinction to prioritize
// actual events over routine noise, rather than inventing a new heuristic.
function isRoutineBulletin(title){
  return /（定時）|\(定時\)/.test(title);
}

async function fetchEarthquakes(){
  const r = await fetchWithTimeout(JMA_EQVOL_FEED_URL, { headers:{ 'user-agent':'JapanNow/1.0' } });
  if(!r.ok) throw new Error('jma_eqvol ' + r.status);
  const xml = await r.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m=>m[1]);
  const parsed = entries.map(block=>{
    const title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const updated = decodeXml(block.match(/<updated>([\s\S]*?)<\/updated>/)?.[1] || '');
    const content = decodeXml(block.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || '');
    const link = block.match(/<link href="([^"]*)"/)?.[1] || '';
    return { title: clean(title), updated, summary: clean(content).slice(0, 200), url: link, isRoutine: isRoutineBulletin(title) };
  }).filter(e=>e.title)
    .sort((a,b)=> new Date(b.updated||0) - new Date(a.updated||0));

  return prioritizeEarthquakeEntries(parsed);
}

// Pulled out as its own function so it can be unit-tested without a network
// call — see tests/japan.test.mjs.
function prioritizeEarthquakeEntries(parsed){
  const urgent = parsed.filter(e => !e.isRoutine);
  const routine = parsed.filter(e => e.isRoutine);

  // Routine bulletins are also deduped by volcano name (the part inside
  // 【火山名 ...】), keeping only the freshest one per mountain — otherwise
  // the same volcano can appear multiple times as JMA reissues its routine
  // bulletin throughout the day.
  const seenVolcano = new Set();
  const dedupedRoutine = [];
  for(const e of routine){
    const volcano = e.title.match(/【火山名\s*([^\s】]+)/)?.[1] || e.title;
    if(seenVolcano.has(volcano)) continue;
    seenVolcano.add(volcano);
    dedupedRoutine.push(e);
  }

  // Urgent entries always win the available slots first; routine ones only
  // fill whatever room is left.
  return [...urgent, ...dedupedRoutine];
}

function fallbackPayload(error){
  return {
    ok: true,
    mode: 'fallback',
    dataStatus: 'FALLBACK — sources unreachable',
    sourceError: error,
    updatedAt: new Date().toISOString(),
    cacheTtlMinutes: Math.round(CACHE_TTL_MS / 60000),
    news: [],
    newsCount: 0,
    newsOk: false,
    warnings: [],
    warningCount: 0,
    warningsOk: false,
    earthquakes: [],
    quakeCount: 0,
    quakesOk: false,
    sourceReport: [{ name:'All sources', ok:false, error }]
  };
}

// Named exports for unit testing pure logic (does not affect the default
// export Vercel invokes — same pattern used in ORACLE's api/risk.js).
export { dedupeByTitleStem, extractActiveWarningNames, parseRss, clean, decodeXml, groupWarningsByPrefecture, prioritizeEarthquakeEntries, isRoutineBulletin };
