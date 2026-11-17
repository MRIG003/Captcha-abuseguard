// @ts-check
/**
 * Store adapter interface. Every method is async and tenant-scoped. Subjects are `{kind, id}` with hashed ids.
 *
 * upsertSubject(tenant, subject, attrs?)          -> subject key
 * getSubject(tenant, subject)                     -> {kind, id, attrs, first_seen, last_seen} or null
 * linkAttribute(tenant, subject, type, valueHash) -> void   link a subject to a hashed attribute (device, payment, ip)
 * clusterSize(tenant, subject, type)              -> number of subjects sharing an attribute of that type (min 1)
 * addUsage(tenant, subject, windowStart, {requests, cost_usd}) -> running totals for the window
 * getUsage(tenant, subject, windowStart)          -> {requests, cost_usd}
 * clusterUsage(tenant, subject, windowStart, types) -> usage summed over subjects sharing an attribute of those types
 * saveDecision(tenant, verdict)                   -> decision id
 * getDecision(tenant, id)                         -> stored verdict or null
 * saveAppeal(tenant, decisionId, {channel, note}) -> appeal id
 * resolveAppeal(tenant, appealId, outcome)        -> decision id   outcome: 'overturned' | 'upheld'
 * saveOutcome(tenant, decisionId, label)          -> void   label: 'abusive' | 'legitimate' | 'converted'
 * accuracy(tenant)                                -> {decisions, non_allow, appeals, overturned, labelled, labelled_abusive}
 *                                                    (labelled counts cover non-allow decisions only)
 * getPolicy(tenant) / putPolicy(tenant, policy)   -> tenant policy object (openapi Policy) or null
 * purge(tenant, olderThanMs)                      -> rows removed (retention limit)
 * eraseSubject(tenant, subject)                   -> void   (erasure request)
 * close()                                         -> void
 */
export const STORE_METHODS = Object.freeze(['upsertSubject', 'getSubject', 'linkAttribute', 'clusterSize', 'addUsage', 'getUsage',
  'clusterUsage', 'saveDecision', 'getDecision', 'saveAppeal', 'resolveAppeal', 'saveOutcome', 'accuracy', 'getPolicy',
  'putPolicy', 'purge', 'eraseSubject', 'close']);

/** Throws if an adapter is missing a method. Adapters must also pass test/store.test.js. */
export function assertStore(store) {
  const missing = STORE_METHODS.filter((name) => typeof store?.[name] !== 'function');
  if (missing.length) throw new TypeError(`store adapter is missing: ${missing.join(', ')}`);
  return store;
}
