// `npm run demo`: bot load and cost audit on synthetic logs, then three explained verdicts. Nothing is enforced.
import { analyzeLines, renderAudit, decide, explain } from '../src/index.js';
import { genLogs, demoAuditOptions } from '../test/synth.js';

const lines = genLogs(1, 30);
const t0 = performance.now();
const report = analyzeLines(lines, demoAuditOptions);
console.log(renderAudit(report));
console.log(`\n(${lines.length} synthetic log lines analysed in ${(performance.now() - t0).toFixed(0)} ms)\n`);

const samples = [
  ['Farm: 30 linked accounts, each under the per-key budget', { subject: { kind: 'device_cluster', id: 'demo1' }, context: { surface: 'api' }, behavior: { device_cluster: 30 }, cost: { usd: 90, budget_usd: 5 } }],
  ['Campus signup rush behind one IP', { subject: { kind: 'account', id: 'demo2' }, context: { surface: 'signup' }, behavior: { ip_cluster: 300, signups_per_hour: 14 } }],
  ['Free user over the daily allowance', { subject: { kind: 'account', id: 'demo3' }, context: { surface: 'api' }, behavior: { email_confirmed: true }, cost: { usd: 7, budget_usd: 5 } }],
];
for (const [title, input] of samples) {
  const text = explain(decide(input));
  console.log(`${title}\n  -> ${text.class}: ${text.headline} (confidence ${text.confidence}, enforced ${text.enforced})`);
  for (const r of text.reasons) console.log(`     ${r.code}: ${r.text}`);
  if (text.next_steps.length) console.log(`     recovery: ${text.next_steps.map((s) => s.path).join(', ')}`);
}
