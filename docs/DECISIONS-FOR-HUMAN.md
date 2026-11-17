# Decisions for the human

1. **Wedge change.** Launch on per-human cost budgets (linked-cluster dollar caps) sold through a free log audit, not the general decision layer. Scraper slow-down and the agent lane stay in the contract but ship second. Confirm or revert (ARCHITECTURE.md ADR-1).
2. **Verify the gap before any sales claim.** Read the Stripe Radar, Verisoul and Cloudflare AI Gateway docs in full (about one hour). If any documents dollar caps across linked accounts, the "better" cells in GAP-ANALYSIS.md fall to parity.
3. **Pricing.** Recommended test: free audit, then $1,500/month flat with a cap on assessed subjects. Percentage-of-savings pricing needs a savings figure both sides trust; defer until the audit number has survived three pilots.
4. **Farm blocks.** Default is step-up for farms and block only at score 0.85 or more with a device or payment link. Confirm you accept blocks at all in enforce mode, or want step-up only for the first customers.
5. **Assistive-tool declaration is self-asserted** and exempts from challenges and slow-downs (not from the per-human cap). It is abusable; the exemption stops at scraper score 0.8 or a linked farm. Confirm this trade-off.
6. **Device and payment linking is personal-data processing.** Needs a DPA, a lawful-basis position (legitimate interest is ASSUMED) and counsel review for GDPR, CCPA and India DPDP before the first EU or Indian pilot.
7. **Cross-tenant signals stay off** (ADR-5). Confirm no customer is promised network effects.
8. **Paying resellers and leaked keys look the same** (one key, many networks). Default is allow plus a webhook for paying customers. Confirm you do not want automatic limits on paying keys.
9. **Hosting.** Recommended: hosted API in one EU and one US region plus a self-host Docker image. Self-host only would shorten security review but removes usage-based pricing.
10. **Name.** "abuseguard" is kept as a working name; no trademark or domain check was done.
