#!/usr/bin/env node
// Bot load and cost audit from a server or CDN log file. Nothing is enforced; IPs and keys are hashed on read.
//   node scripts/audit.js access.log --disallow /private/ --endpoint-cost /api/generate=0.02 --converted /checkout/complete
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { analyzeFile, renderAudit, loadConfig } from '../src/index.js';

const HELP = `usage: node scripts/audit.js <logfile> [options]
  --disallow <prefix>          robots.txt Disallow prefix (repeatable)
  --endpoint-cost <prefix=usd> dollar cost per call of an expensive endpoint (repeatable)
  --converted <prefix>         path that means a conversion (repeatable)
  --budget <usd>               budget per subject for the log window (default AG_BUDGET_USD or 5)
  --salt <text>                hashing salt (default: audit)
  --top <n>                    subjects to list (default 10)
  --json                       print the full report as JSON
  --out <file>                 write the output to a file
Log formats: combined log format (optionally with request time as the last field) or JSON lines
{ts, ip, path, status, bytes, ua, rt, key}.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    disallow: { type: 'string', multiple: true, default: [] }, 'endpoint-cost': { type: 'string', multiple: true, default: [] },
    converted: { type: 'string', multiple: true, default: [] }, budget: { type: 'string' }, salt: { type: 'string', default: 'audit' },
    top: { type: 'string', default: '10' }, json: { type: 'boolean', default: false }, out: { type: 'string' }, help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help || positionals.length !== 1) { console.log(HELP); process.exit(values.help ? 0 : 2); }

const endpointCosts = values['endpoint-cost'].map((pair) => {
  const at = pair.lastIndexOf('='), usd = Number(pair.slice(at + 1));
  if (at < 1 || !(usd >= 0)) { console.error(`bad --endpoint-cost "${pair}", expected prefix=usd`); process.exit(2); }
  return { prefix: pair.slice(0, at), usd };
});
const config = loadConfig(process.env, values.budget ? { budgetUsd: Number(values.budget) } : {});

try {
  const report = await analyzeFile(positionals[0], {
    salt: values.salt, config, disallow: values.disallow, convertedPaths: values.converted, endpointCosts, top: Number(values.top),
  });
  if (report.lines === report.skipped) { console.error(`no parsable log lines in ${positionals[0]} (${report.lines} lines read)`); process.exit(1); }
  const text = values.json ? JSON.stringify(report, null, 2) : renderAudit(report);
  if (values.out) { writeFileSync(values.out, `${text}\n`); console.log(`report written to ${values.out}`); } else console.log(text);
} catch (err) {
  console.error(`audit failed: ${err.message}`);
  process.exit(1);
}
