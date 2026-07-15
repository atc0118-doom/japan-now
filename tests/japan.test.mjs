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
  extractActiveWarningNames,
  parseRss,
  clean,
  decodeXml,
  groupWarningsByPrefecture
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
