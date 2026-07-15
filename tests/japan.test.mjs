// Unit tests for api/japan.js.
// Run with: node --test tests/japan.test.mjs
//
// The extractActiveWarningNames tests below use a REAL response captured
// from https://www.jma.go.jp/bosai/warning/data/warning/130000.json while
// building this — not a guessed/invented shape. The first version of this
// function assumed a `{name, status}` schema based on general research, and
// would have silently matched nothing against the real `{code, status}`
// schema, returning zero warnings on every single request forever. This
// test exists specifically so that regression can't happen silently again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeByTitleStem,
  titleStem,
  isSourceOk,
  extractActiveWarningNames,
  parseRss,
  clean,
  decodeXml,
  groupWarningsByPrefecture,
  prioritizeEarthquakeEntries,
  isRoutineBulletin,
  capPerPrefecture
} from '../api/japan.js';

// Trimmed down but structurally real fixture (captured live, then trimmed
// to the relevant areas) — not synthesized from assumptions.
const REAL_WARNING_FIXTURE = {
  reportDatetime: '2026-05-28T10:16:00+09:00',
  publishingOffice: '気象庁',
  areaTypes: [{
    areas: [
      { code: '130010', warnings: [{ status: '発表警報・注意報はなし' }] },
      { code: '130020', warnings: [{ code: '14', status: '継続' }, { code: '20', status: '継続' }] },
      { code: '130030', warnings: [{ code: '14', status: '継続' }, { code: '15', status: '継続' }, { code: '16', status: '継続' }, { code: '20', status: '継続' }] },
      { code: '130040', warnings: [{ code: '20', status: '解除' }] }
    ]
  }]
};

test('extractActiveWarningNames pulls active warnings from a real JMA response shape', () => {
  const names = extractActiveWarningNames(REAL_WARNING_FIXTURE);
  assert.ok(names.includes('雷注意報'), 'should include thunder advisory (code 14)');
  assert.ok(names.includes('強風注意報'), 'should include wind advisory (code 15)');
  assert.ok(names.includes('波浪注意報'), 'should include wave advisory (code 16)');
  assert.ok(names.includes('濃霧注意報'), 'should include fog advisory (code 20)');
});

test('extractActiveWarningNames excludes cleared (解除) warnings', () => {
  // Area 130040 in the fixture has code 20 but status "解除" (cleared) — it
  // must not contribute a warning on its own. (Code 20 does still appear
  // overall because OTHER areas in the fixture have it active — this test
  // just confirms a cleared-only area contributes nothing extra.)
  const clearedOnly = { areaTypes: [{ areas: [{ code: '130040', warnings: [{ code: '20', status: '解除' }] }] }] };
  const names = extractActiveWarningNames(clearedOnly);
  assert.deepEqual(names, [], 'a fixture with only a cleared warning should produce zero active warnings');
});

test('extractActiveWarningNames returns empty for "no warnings issued" entries', () => {
  const noneIssued = { areaTypes: [{ areas: [{ code: '130010', warnings: [{ status: '発表警報・注意報はなし' }] }] }] };
  const names = extractActiveWarningNames(noneIssued);
  assert.deepEqual(names, []);
});

test('extractActiveWarningNames falls back to a labeled code for unrecognized codes rather than dropping them silently', () => {
  const unknownCode = { areaTypes: [{ areas: [{ code: '999999', warnings: [{ code: '99', status: '継続' }] }] }] };
  const names = extractActiveWarningNames(unknownCode);
  assert.equal(names.length, 1);
  assert.match(names[0], /99/, 'unrecognized codes should still surface, labeled, instead of vanishing');
});

test('extractActiveWarningNames handles totally empty/malformed input without throwing', () => {
  assert.deepEqual(extractActiveWarningNames(null), []);
  assert.deepEqual(extractActiveWarningNames({}), []);
  assert.deepEqual(extractActiveWarningNames({ foo: 'bar' }), []);
});

test('decodeXml unescapes standard XML entities', () => {
  assert.equal(decodeXml('A &amp; B &lt;tag&gt; &quot;quoted&quot; &#39;it&#39;s&#39;'), `A & B <tag> "quoted" 'it's'`);
});

test('decodeXml unescapes &nbsp; and &#160; as real whitespace (regression)', () => {
  // Confirmed root cause of a persistent "outlet name suffix never gets
  // stripped" bug: some titles use a literal "&nbsp;" instead of a real
  // space around the separator. Left undecoded, "&nbsp;" is 6 non-whitespace
  // characters, so the title-cleanup regex's \s+ requirement never matched
  // and nothing got stripped at all.
  assert.equal(decodeXml('A&nbsp;B'), 'A B');
  assert.equal(decodeXml('A&#160;B'), 'A B');
});

test('parseRss strips an outlet-name suffix even when separated by literal &nbsp; instead of a real space (regression)', () => {
  const xml = `<item><title>皇室典範改正案 参院で審議 きょう午後採決で調整（2026年7月14日掲載）&nbsp;|&nbsp;日テレNEWS NNN</title><link>https://example.com/8</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items[0].title, '皇室典範改正案 参院で審議 きょう午後採決で調整（2026年7月14日掲載）');
});

test('clean collapses whitespace and trims', () => {
  assert.equal(clean('  hello   world  \n\t'), 'hello world');
});

test('parseRss strips a trailing broadcaster network-code credit like "(NNN)"', () => {
  const xml = `<item><title>大雨で川が氾濫危険水位に迫る (NNN)</title><link>https://example.com/2</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items[0].title, '大雨で川が氾濫危険水位に迫る');
});

test('parseRss strips a full-width trailing network-code credit like "（NNN）"', () => {
  const xml = `<item><title>台風接近で交通機関に影響（NNN）</title><link>https://example.com/3</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items[0].title, '台風接近で交通機関に影響');
});

test('parseRss does NOT strip genuine Japanese parenthetical content', () => {
  const xml = `<item><title>首相会見（要旨）詳細を発表</title><link>https://example.com/4</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items[0].title, '首相会見（要旨）詳細を発表', 'legitimate Japanese parenthetical content should not be mistaken for a network credit');
});

test('parseRss strips a trailing pipe-separated outlet suffix (e.g. "| TBS NEWS DIG")', () => {
  const xml = `<item><title>見出しテスト | TBS NEWS DIG (1ページ)</title><link>https://example.com/5</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items[0].title, '見出しテスト');
});

test('parseRss strips a trailing FULLWIDTH pipe-separated outlet suffix (e.g. "｜ 日テレNEWS NNN")', () => {
  // Regression: a real headline slipped through because the outlet used the
  // fullwidth pipe｜(U+FF5C), which the ASCII-only regex didn't match.
  const xml = `<item><title>皇室典範改正案 参院で審議 きょう午後採決で調整（2026年7月14日掲載） ｜ 日テレNEWS NNN</title><link>https://example.com/6</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items[0].title, '皇室典範改正案 参院で審議 きょう午後採決で調整（2026年7月14日掲載）');
});

test('parseRss strips a trailing parenthetical mixing the outlet name with a network code (e.g. "（日テレNEWS NNN）")', () => {
  // Regression: a real headline slipped through because the parenthetical
  // contained more than just the bare code ("日テレNEWS NNN", not just "NNN"),
  // which the original all-uppercase-only regex didn't match.
  const xml = `<item><title>台風9号は温帯低気圧に前線ともない今夜から北日本を通過大雨おそれ（日テレNEWS NNN）</title><link>https://example.com/7</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items[0].title, '台風9号は温帯低気圧に前線ともない今夜から北日本を通過大雨おそれ');
});

test('parseRss extracts title/link/source/pubDate from a minimal RSS item', () => {
  const xml = `<rss><channel>
    <item>
      <title><![CDATA[テスト見出し - NHK NEWS WEB]]></title>
      <link>https://example.com/article/1</link>
      <pubDate>Mon, 01 Jun 2026 12:00:00 +0900</pubDate>
    </item>
  </channel></rss>`;
  const items = parseRss(xml, 'NHK');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'テスト見出し');
  assert.equal(items[0].url, 'https://example.com/article/1');
  assert.equal(items[0].source, 'NHK');
});

test('parseRss skips items missing a title or link', () => {
  const xml = `<item><title>No link here</title></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items.length, 0);
});

test('dedupeByTitleStem collapses headlines sharing an identical word stem', () => {
  const sharedStem = '東京都で震度５弱の地震が発生し各地で被害の確認が続いている';
  const items = [
    { title: `${sharedStem}模様` },
    { title: `${sharedStem}状況` },
    { title: '全く関係ない別のニュース見出しです' }
  ];
  const out = dedupeByTitleStem(items);
  assert.ok(out.length <= 2, 'near-duplicate headlines should collapse');
});

test('dedupeByTitleStem keeps genuinely distinct headlines', () => {
  const items = [
    { title: '東京都心で大雨警報が発表された' },
    { title: '大阪府で選挙の投開票が行われた' },
    { title: '北海道で観測史上最低気温を記録した' }
  ];
  const out = dedupeByTitleStem(items);
  assert.equal(out.length, 3);
});

// Regression tests for the "北海道から順番のがよくない？" fix: warnings should be
// grouped by prefecture (collapsing Hokkaido's 8 offices and Okinawa's 4
// into single rows) and preserve north-to-south input order.

test('groupWarningsByPrefecture merges Hokkaido sub-region offices into one row', () => {
  const officeResults = [
    { office: { code:'011000', name:'宗谷地方' }, warnings: ['雷注意報'] },
    { office: { code:'016000', name:'石狩・空知・後志地方' }, warnings: ['大雨注意報', '雷注意報'] },
    { office: { code:'014030', name:'十勝地方' }, warnings: ['濃霧注意報'] }
  ];
  const result = groupWarningsByPrefecture(officeResults);
  assert.equal(result.length, 1, 'all three Hokkaido sub-regions should collapse into a single row');
  assert.equal(result[0].prefecture, '北海道');
  assert.ok(result[0].warnings.includes('雷注意報'));
  assert.ok(result[0].warnings.includes('大雨注意報'));
  assert.ok(result[0].warnings.includes('濃霧注意報'));
  // Deduplicated, not double-counted, even though 雷注意報 appeared in two offices.
  assert.equal(result[0].warnings.filter(w=>w==='雷注意報').length, 1);
});

test('groupWarningsByPrefecture merges Okinawa sub-region offices into one row', () => {
  const officeResults = [
    { office: { code:'471000', name:'沖縄本島地方' }, warnings: ['波浪警報'] },
    { office: { code:'473000', name:'宮古島地方' }, warnings: ['強風注意報'] }
  ];
  const result = groupWarningsByPrefecture(officeResults);
  assert.equal(result.length, 1);
  assert.equal(result[0].prefecture, '沖縄県');
});

test('groupWarningsByPrefecture keeps Kagoshima mainland and Amami separate (deliberately not grouped)', () => {
  const officeResults = [
    { office: { code:'460100', name:'鹿児島県（奄美地方除く）' }, warnings: ['大雨警報'] },
    { office: { code:'460040', name:'奄美地方' }, warnings: ['波浪警報'] }
  ];
  const result = groupWarningsByPrefecture(officeResults);
  assert.equal(result.length, 2, 'Amami is geographically distant with materially different weather and should stay a separate row');
});

test('groupWarningsByPrefecture keeps ordinary prefectures as individual rows, unaffected by grouping', () => {
  const officeResults = [
    { office: { code:'130000', name:'東京都' }, warnings: ['雷注意報'] },
    { office: { code:'270000', name:'大阪府' }, warnings: ['濃霧注意報'] }
  ];
  const result = groupWarningsByPrefecture(officeResults);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(r=>r.prefecture).sort(), ['大阪府','東京都']);
});

test('groupWarningsByPrefecture preserves north-to-south input order in its output', () => {
  // Simulates the real fetchJMAOffices order: Hokkaido sub-regions first,
  // then Kanto, then Okinawa last — output row order should follow the
  // FIRST time each display label is encountered, in input order.
  const officeResults = [
    { office: { code:'011000', name:'宗谷地方' }, warnings: ['雷注意報'] },       // -> 北海道 (first seen here)
    { office: { code:'130000', name:'東京都' }, warnings: ['濃霧注意報'] },        // -> 東京都
    { office: { code:'016000', name:'石狩・空知・後志地方' }, warnings: ['大雨注意報'] }, // -> 北海道 again (already grouped)
    { office: { code:'471000', name:'沖縄本島地方' }, warnings: ['波浪警報'] }       // -> 沖縄県
  ];
  const result = groupWarningsByPrefecture(officeResults);
  assert.deepEqual(result.map(r=>r.prefecture), ['北海道', '東京都', '沖縄県'], 'output order should follow first-seen order, not re-sort alphabetically or otherwise');
});

test('groupWarningsByPrefecture skips offices with no active warnings', () => {
  const officeResults = [
    { office: { code:'130000', name:'東京都' }, warnings: [] },
    { office: { code:'270000', name:'大阪府' }, warnings: ['雷注意報'] }
  ];
  const result = groupWarningsByPrefecture(officeResults);
  assert.equal(result.length, 1);
  assert.equal(result[0].prefecture, '大阪府');
});

// Regression tests for the "地震・火山情報が降灰予報（定時）だらけ" fix: actual
// event reports should always be prioritized over routine scheduled
// bulletins, and routine bulletins should be deduped per volcano.

test('isRoutineBulletin correctly identifies scheduled ashfall bulletins', () => {
  assert.equal(isRoutineBulletin('降灰予報（定時）'), true);
  assert.equal(isRoutineBulletin('降灰予報(定時)'), true, 'half-width parens should also match');
  assert.equal(isRoutineBulletin('震度速報'), false);
  assert.equal(isRoutineBulletin('噴火警報'), false);
  assert.equal(isRoutineBulletin('地震情報'), false);
});

test('prioritizeEarthquakeEntries puts urgent reports before routine bulletins, regardless of recency', () => {
  const entries = [
    { title: '【火山名 霧島山（新燃岳） 降灰予報（定時）】現在...', updated: '2026-07-15T12:00:00+09:00', isRoutine: true },
    { title: '【火山名 岩手山 降灰予報（定時）】現在...', updated: '2026-07-15T11:00:00+09:00', isRoutine: true },
    { title: '震度速報 東北地方で震度4を観測', updated: '2026-07-15T09:00:00+09:00', isRoutine: false }
  ];
  const result = prioritizeEarthquakeEntries(entries);
  assert.equal(result[0].title, '震度速報 東北地方で震度4を観測', 'the actual earthquake report should come first even though it is older than the routine bulletins');
});

test('prioritizeEarthquakeEntries dedupes routine bulletins by volcano, keeping only the freshest', () => {
  const entries = [
    { title: '【火山名 霧島山（新燃岳） 降灰予報（定時）】15時発表分', updated: '2026-07-15T15:00:00+09:00', isRoutine: true },
    { title: '【火山名 霧島山（新燃岳） 降灰予報（定時）】12時発表分', updated: '2026-07-15T12:00:00+09:00', isRoutine: true },
    { title: '【火山名 岩手山 降灰予報（定時）】現在...', updated: '2026-07-15T14:00:00+09:00', isRoutine: true }
  ];
  const result = prioritizeEarthquakeEntries(entries);
  const kirishimaEntries = result.filter(e => e.title.includes('霧島山'));
  assert.equal(kirishimaEntries.length, 1, 'only the freshest 霧島山 bulletin should remain');
  assert.equal(kirishimaEntries[0].title, '【火山名 霧島山（新燃岳） 降灰予報（定時）】15時発表分');
  assert.equal(result.length, 2, 'one deduped 霧島山 entry plus the 岩手山 entry');
});

test('prioritizeEarthquakeEntries keeps all urgent entries even if there are many routine ones', () => {
  const routineEntries = Array.from({length: 15}, (_, i) => ({
    title: `【火山名 山${i} 降灰予報（定時）】`, updated: '2026-07-15T12:00:00+09:00', isRoutine: true
  }));
  const urgentEntry = { title: '震度速報 関東地方で震度3を観測', updated: '2026-07-15T01:00:00+09:00', isRoutine: false };
  const result = prioritizeEarthquakeEntries([...routineEntries, urgentEntry]);
  assert.ok(result.some(e => e.title === urgentEntry.title), 'the single urgent entry must not be crowded out by 15 routine bulletins');
  assert.equal(result[0].title, urgentEntry.title, 'urgent entries come first');
});

test('parseRss strips a domain-name suffix even when the domain itself contains a hyphen', () => {
  // Regression: "fukuoka-u.ac.jp" has a hyphen in "fukuoka-u", which broke
  // the general suffix stripper (it requires zero hyphens in the trailing
  // content). A domain-shaped suffix should still be stripped regardless.
  const xml = `<item><title>豪雨や災害の実態と備え「耐震」と「免震」は違うもの - fukuoka-u.ac.jp</title><link>https://example.com/9</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items[0].title, '豪雨や災害の実態と備え「耐震」と「免震」は違うもの');
});

test('parseRss filters out a title ending in a leaked "og_description" placeholder', () => {
  // Regression: real observed case was "レバンガ北海道 og_description" — a
  // legitimate-looking prefix with a literal Open Graph meta-tag name
  // appended, not a real headline.
  const xml = `<item><title>レバンガ北海道 og_description</title><link>https://example.com/10</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items.length, 0, 'a title ending in a known placeholder token should be filtered out entirely');
});

test('parseRss does not filter out a normal headline that merely contains similar-looking words', () => {
  const xml = `<item><title>本当に良い普通の見出しです</title><link>https://example.com/11</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items.length, 1);
});


test('parseRss strips a pipe suffix even with no space before the pipe', () => {
  const xml = `<item><title>皇室典範改正案、きょうの採決見送り 野党側は「旧宮家養子案」追及（2026年7月14日掲載）|日テレNEWS NNN</title><link>https://example.com/12</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items[0].title, '皇室典範改正案、きょうの採決見送り 野党側は「旧宮家養子案」追及（2026年7月14日掲載）');
});

test('parseRss strips a pipe suffix even with no space after the pipe', () => {
  const xml = `<item><title>皇室典範改正案、きょうの採決見送り 野党側は「旧宮家養子案」追及（2026年7月14日掲載） |日テレNEWS NNN</title><link>https://example.com/13</link></item>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items[0].title, '皇室典範改正案、きょうの採決見送り 野党側は「旧宮家養子案」追及（2026年7月14日掲載）');
});

test('titleStem produces the same stem for two headlines sharing an identical opening', () => {
  const shared = '北海道で大雪となり交通機関に大きな影響が出ている模様で気象台が注意を呼びかけている';
  const a = titleStem(`${shared}という内容の記事です`);
  const b = titleStem(`${shared}とのことで詳細を確認中`);
  assert.equal(a, b, 'both headlines share a long enough opening that the 24-character stem should be identical');
});

test('titleStem is stable regardless of case and punctuation noise', () => {
  const a = titleStem('Tokyo Marathon 2026!!');
  const b = titleStem('tokyo marathon 2026');
  assert.equal(a, b);
});

// Regression tests for isSourceOk: the exact spot where a real bug happened
// (the regional news section briefly reused a blanket "did ANY of the 3
// news sources succeed" flag instead of checking its own source).

test('isSourceOk returns true when the named source succeeded', () => {
  const report = [
    { name: 'NHK', ok: true },
    { name: 'Google News (Japan)', ok: true },
    { name: 'Google News (地域)', ok: true }
  ];
  assert.equal(isSourceOk('fulfilled', report, 'Google News (地域)'), true);
});

test('isSourceOk returns false when the named source failed even though other sources in the same batch succeeded', () => {
  const report = [
    { name: 'NHK', ok: true },
    { name: 'Google News (Japan)', ok: true },
    { name: 'Google News (地域)', ok: false, error: 'timeout' }
  ];
  assert.equal(isSourceOk('fulfilled', report, 'Google News (地域)'), false, 'a specific source failing must not be masked by other sources succeeding');
});

test('isSourceOk returns false when the whole settled batch rejected, even if the fallback report happens to lack this source name', () => {
  // This mirrors buildPayload's real fallback shape: when fetchAllNews()
  // itself throws, newsReport becomes a single generic placeholder entry
  // that doesn't mention any specific source by name.
  const fallbackReport = [{ name: 'News', ok: false, error: 'crash' }];
  assert.equal(isSourceOk('rejected', fallbackReport, 'Google News (地域)'), false);
});

test('isSourceOk treats a missing source name as unverified, not confirmed-ok', () => {
  // FIX: this used to default to true when the name wasn't found — but
  // "not found" means "we can't confirm this succeeded", which should never
  // be presented as "ok", the same principle applied everywhere else in
  // this project (baseline data, degraded sources, etc.).
  const report = [{ name: 'NHK', ok: true }];
  assert.equal(isSourceOk('fulfilled', report, 'Some Source That Does Not Exist'), false);
});

// Regression tests for the "地方ニュース、北海道、東北ばかり" fix: no single
// prefecture should be able to dominate the regional news list.

test('capPerPrefecture limits how many articles a single prefecture can contribute', () => {
  const items = Array.from({length: 10}, (_, i) => ({ title: `北海道でニュース${i}件目が発生` }));
  const result = capPerPrefecture(items, 3);
  assert.equal(result.length, 3, 'only 3 of the 10 Hokkaido articles should survive the cap');
});

test('capPerPrefecture lets different prefectures each contribute up to the cap independently', () => {
  const items = [
    ...Array.from({length: 5}, (_, i) => ({ title: `北海道の話題${i}` })),
    ...Array.from({length: 5}, (_, i) => ({ title: `愛媛県の話題${i}` }))
  ];
  const result = capPerPrefecture(items, 3);
  assert.equal(result.length, 6, '3 from Hokkaido + 3 from Ehime');
});

test('capPerPrefecture counts a multi-region article against only the first matching prefecture, not every region it mentions', () => {
  const items = [
    { title: '北海道・東北地方で大雨警報' }, // matches both 北海道 and one of the Tohoku names
    ...Array.from({length: 3}, (_, i) => ({ title: `北海道の別の話題${i}` }))
  ];
  const result = capPerPrefecture(items, 3);
  // The multi-region article counts once (against 北海道, the first match in
  // PREFECTURE_NAMES order), leaving room for exactly 2 more 北海道 articles
  // before hitting the cap of 3.
  assert.equal(result.length, 3);
});

test('capPerPrefecture leaves articles with no matching prefecture name untouched (not capped, since they cannot be attributed)', () => {
  const items = [
    { title: '見出しに都道府県名が含まれない記事' },
    { title: 'また別の都道府県名なし記事' }
  ];
  const result = capPerPrefecture(items, 1);
  assert.equal(result.length, 2, 'articles that cannot be attributed to any prefecture should not be capped');
});
