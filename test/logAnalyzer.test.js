import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLines, parseLine, uaClass, renderAudit, attributeCost, loadConfig, hashId } from '../src/index.js';
import { genLogs, demoAuditOptions } from './synth.js';

test('parseLine reads combined log format with request time', () => {
  const e = parseLine('198.51.100.23 - - [01/Nov/2026:12:00:05 +0100] "GET /a?b=1 HTTP/1.1" 200 512 "-" "curl/8.5" 0.250');
  assert.deepEqual({ ...e }, { ts: Date.UTC(2026, 10, 1, 11, 0, 5), ip: '198.51.100.23', key: null, path: '/a?b=1', status: 200, bytes: 512, ua: 'curl/8.5', rt: 0.25 });
  assert.equal(parseLine('1.2.3.4 - - [01/Nov/2026:12:00:05 +0000] "GET / HTTP/1.1" 304 -').bytes, 0);
});

test('parseLine reads JSON lines and rejects garbage', () => {
  const e = parseLine(JSON.stringify({ ts: '2026-11-01T12:00:00Z', ip: '1.2.3.4', path: '/x', status: 200, bytes: 10, ua: 'x', rt: 1, key: 'sk_1' }));
  assert.equal(e.key, 'sk_1');
  assert.equal(e.ts, Date.UTC(2026, 10, 1, 12));
  for (const bad of ['', 'nonsense', '{"path":1}', '{broken', '1.2.3.4 - - [bad] "GET / HTTP/1.1" 200 1']) assert.equal(parseLine(bad), null);
});

test('uaClass', () => {
  assert.equal(uaClass('Mozilla/5.0 (compatible; Googlebot/2.1)'), 'declared_bot');
  assert.equal(uaClass('python-requests/2.32'), 'library');
  assert.equal(uaClass('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'), 'browser');
  assert.equal(uaClass('Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 6.1; Trident/4.0)'), 'browser');
  assert.equal(uaClass('Debian APT-HTTP/1.3 (0.8.16)'), 'library');
  assert.equal(uaClass('Mozilla/5.0 (compatible; YandexImages/3.0; +http://yandex.com/bots)'), 'declared_bot');
  assert.equal(uaClass('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'), 'declared_bot');
  assert.equal(uaClass('Mozilla/5.0 ChatGPT-User/1.0'), 'declared_agent');
  assert.equal(uaClass('-'), 'empty');
});

test('audit of synthetic logs: classes, costs and privacy', () => {
  const lines = genLogs(1, 10);
  const report = analyzeLines(lines, demoAuditOptions);
  assert.equal(report.lines, lines.length);
  assert.equal(report.skipped, 1);
  assert.equal(report.by_class.search_engine.subjects, 1);
  assert.equal(report.by_class.suspected_scraper.subjects, 1);
  assert.equal(report.by_class.declared_crawler.subjects, 1);
  assert.equal(report.by_decision.slow, 1);
  assert.equal(report.good_traffic.subjects_converted, 6);
  const sum = Object.values(report.by_class).reduce((a, c) => a + c.cost_usd, 0);
  assert.ok(Math.abs(sum - report.totals.cost_usd) < 1e-9);
  assert.ok(report.estimated_savings_usd > 0 && report.estimated_savings_usd <= report.totals.cost_usd);
  const text = JSON.stringify(report) + renderAudit(report);
  assert.ok(!/198\.51\.100\.|66\.249\./.test(text), 'raw IP addresses must not appear in the report');
  assert.match(renderAudit(report), /estimated savings \$/);
});

test('JSON logs with API keys become api_key subjects with endpoint cost', () => {
  const lines = Array.from({ length: 400 }, (_, i) => JSON.stringify({ ts: Date.UTC(2026, 10, 1, 12, 0, i % 60), ip: `10.1.1.${i % 200}`, path: '/api/generate', status: 200, bytes: 1000, ua: 'sdk', key: 'sk_live_abc', rt: 1 }));
  const report = analyzeLines(lines, { endpointCosts: [{ prefix: '/api/generate', usd: 0.02 }] });
  assert.equal(report.subjects, 1);
  assert.equal(report.top_subjects[0].subject, `api_key:${hashId('audit', 'sk_live_abc')}`);
  assert.equal(report.top_subjects[0].decision, 'limit');
  assert.ok(Math.abs(report.totals.cost_usd - 400 * attributeCost({ cpu_s: 1, bytes: 1000, direct_usd: 0.02 })) < 1e-9);
});

test('loadConfig reads env vars and falls back to defaults', () => {
  const cfg = loadConfig({ AG_MODE: 'enforce', AG_BUDGET_USD: '12.5', AG_FARM_BLOCK: 'oops', AG_FAIL_MODE: 'closed' });
  assert.deepEqual([cfg.mode, cfg.budgetUsd, cfg.farmBlock, cfg.failMode], ['enforce', 12.5, 0.85, 'closed']);
  assert.equal(loadConfig().mode, 'shadow');
});

test('pattern features: trap links, enumeration and a browser that loads no assets', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  const at = (i) => { const d = new Date(Date.UTC(2026, 10, 1, 12, 0, 0) + i * 3000); return `${String(d.getUTCDate()).padStart(2, '0')}/Nov/2026:${d.toISOString().slice(11, 19)} +0000`; };
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`203.0.113.50 - - [${at(i)}] "GET /listing/${1000 + i} HTTP/1.1" 200 9000 "-" "${ua}"`);
  lines.push(`203.0.113.50 - - [${at(300)}] "GET /listing/marker-7f3a HTTP/1.1" 200 9000 "-" "${ua}"`);
  for (let i = 0; i < 40; i++) { // a real reader on the same site: pages plus their assets
    lines.push(`198.51.100.9 - - [${at(i * 7)}] "GET /listing/${5000 + i * 13} HTTP/1.1" 200 9000 "-" "${ua}"`);
    lines.push(`198.51.100.9 - - [${at(i * 7)}] "GET /static/app.css HTTP/1.1" 200 3000 "-" "${ua}"`);
    lines.push(`198.51.100.9 - - [${at(i * 7)}] "GET /img/photo-${i}.jpg HTTP/1.1" 200 50000 "-" "${ua}"`);
  }
  const report = analyzeLines(lines, { trapPaths: ['/listing/marker-'], top: 5 });
  const scraper = report.top_subjects.find((r) => r.requests === 301), reader = report.top_subjects.find((r) => r.requests === 120);
  assert.deepEqual([scraper.class, scraper.decision], ['suspected_scraper', 'slow']);
  for (const code of ['TRAP_LINK', 'PATH_ENUMERATION', 'BROWSER_WITHOUT_ASSETS']) assert.ok(scraper.reasons.includes(code), code);
  assert.deepEqual([reader.class, reader.decision], ['legitimate_user', 'allow']);
});
