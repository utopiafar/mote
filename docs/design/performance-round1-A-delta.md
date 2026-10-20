# Detail batching query delta

Original approved plan SHA256:
`18b356d3a3d3001ea8fffdf8bfbdfa218230a376a41191d31b8c8dbd41c315d2`.
Base and current HEAD remain `af11ab7c3e9fb5f38deaea4e4bae11462a7306b4`.
This delta changes only the dependency SQL shape within the approved reader
scope; the head index and all output/owner/lifecycle/validation boundaries stay.

The first generated run proved UNION ALL output equivalence, but the 100-step
detail benchmark regressed from roughly 1.8 ms to 4.2 ms per read. Large compound
query preparation/merge sorting outweighs the saved API calls. Do not ship that
shape or claim it improves latency.

Proposed replacement, pending independent delta review: keep batches of at most
100 already-authorized output IDs, bind a JSON array and use a correlated scalar
subquery per selected step:

```sql
SELECT step.value step_id,
 (SELECT json_group_array(dependency_id) FROM
   (SELECT dependency_id FROM execution_dependencies
    WHERE step_id=step.value ORDER BY dependency_id LIMIT 100)) dependencies
FROM json_each(?) step
```

The nested ORDER/LIMIT executes for each selected ID using the dependency PK;
the ordered array has the same first 100 strings. Decode the array and map by
step ID into unchanged page order. Empty dependencies produce `[]`; an empty
page issues no dependency query. No unrelated IDs or lookahead are bound.
There is no global dependency scan, new cache, new SQL owner selector or await.
JSON1 is already used by current scoped queries and the baseline Node SQLite.

KEEP all full-output reference and real scoped HTTP tests, 0/1/99/100 and >100
cap fixtures, owner 404, large direct page/batch boundary, rollback/restart and
scale. CHANGE instrumentation to inspect JSON-bound output IDs, assert the
correlated per-step ORDER/LIMIT and EXPLAIN dependency PK lookup. Do not relax
the limit/order/content assertions, scales, entry points or success criteria.
Measure both shapes through the same heavy lease. REMOVE only the compound
SQL; EXCEPTION none; UNKNOWN the timing improvement until measured.

The first scale tests stopped on invalid generated deletion input (nonempty
text). Correct that fixture to the existing metadata-only deletion contract;
this does not reduce intended coverage or change product behavior.
