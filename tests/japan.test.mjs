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
  decodeXml
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
