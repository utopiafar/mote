# Continuous processing and usage accounting

Enabled and authorized background work continues under the existing concurrency,
fairness, timeout, retry and input/output bounds. Mote has no daily call or input
character allowance, and no daily, provider or Operation token/cost hard budget.
UTC midnight never releases an application processing allowance. Deduplication,
caching, incremental work and owner scheduling settings control unnecessary work.
Provider account quotas and Retry-After remain provider constraints.

`GET /api/processing` exposes lane policies as `{concurrency, enabled}`.
`PUT /api/processing/settings` accepts the complete four-lane policy. Disabled
lanes block before consuming an execution attempt; enabling a lane makes its
disabled steps eligible again. Normal cancellation, input version checks and
parent authorization remain authoritative.

The model budget API and Web/Android budget editors have been removed. Actual
usage receipts, model prices, daily usage charts and cost estimates remain.
Unknown or incomplete usage still cannot be reported as zero cost. Evidence
authorization continues before every outbound HTTP model attempt, including
repair and compression turns; that private channel reserves no allowance.

Fresh epoch 4 installs only current lane settings. No old-budget tables, setting
conversion or budget-wait revival run at startup. An older vault is rejected
before schema initialization. Current provider waits, checkpoints and leases
continue through the ordinary execution engine. See [MVP baseline](adr-mvp-baseline.md).

A large backlog can now drain in the same day, increasing short-term model
activity and resource use. Mote does not guarantee a maximum daily or per-task
bill. Cost visibility is provided by the usage ledger rather than reservations.
Changing processing policies or reading usage remains owner-only; query agents
receive read-only evidence tools.

Fixture regression coverage verifies work beyond the former call/character
allowances, concurrent execution bounds, explicit lane disablement, current restart
recovery, usage accounting and request evidence authorization. Physical-device
and live-model checks must be reported separately.
