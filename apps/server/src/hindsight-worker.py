"""Pinned Hindsight 0.10.2 worker with host-owned operation-bank admission.

Only transport/scheduling is narrowed. The upstream native executor still
performs retain, integration, import and their observed child work. A worker
restart for an independent manual operation cannot resume another bank's
automatic work. No imported content can change the admitted bank list.
"""
import json
import os
import re
from importlib.metadata import version
from pathlib import Path

from hindsight_api.engine.schema import fq_table_explicit as fq_table
from hindsight_api.worker.poller import WorkerPoller, ClaimedTask
from hindsight_api.worker.main import main

if version("hindsight-api-slim") != "0.10.2":
    raise RuntimeError("The controlled worker requires the pinned Hindsight release")

banks = json.loads(os.environ["MOTE_HINDSIGHT_ADMITTED_BANKS"])
if not isinstance(banks, list) or not banks or any(
    not isinstance(bank, str) or not re.fullmatch(r"mote-(canonical|stage|read)-[a-f0-9]{40}", bank)
    for bank in banks
):
    raise RuntimeError("Invalid host-issued operation bank admission")

identity = os.environ["MOTE_HINDSIGHT_RUNTIME_ID"]
if not re.fullmatch(r"[a-f0-9]{24}", identity):
    raise RuntimeError("Invalid owned runtime identity")
Path("/tmp/mote-worker-" + identity + ".pid").write_text(str(os.getpid()))


async def claim_admitted(self, conn, schema, reserved_limits, shared_limit):
    # This distribution uses one serial worker slot. No other process is
    # authorized to poll its database. Parameterized bank equality is checked
    # before locking or changing any operation; peers from other banks remain
    # pending with their original authorization and receipts intact.
    if schema not in (None, "public") or sum(reserved_limits.values()) + shared_limit < 1:
        return []
    table = fq_table("async_operations", schema)
    async with conn.transaction():
        rows = await conn.fetch(
            f"""SELECT operation_id,bank_id,task_payload,retry_count,operation_type
                FROM {table}
                WHERE bank_id = ANY($1::text[]) AND status='pending'
                  AND task_payload IS NOT NULL
                  AND (next_retry_at IS NULL OR next_retry_at <= NOW())
                ORDER BY created_at,operation_id LIMIT 1 FOR UPDATE SKIP LOCKED""",
            banks,
        )
        await self._backend.ops.mark_operations_processing(
            conn, table, self._worker_id, [row["operation_id"] for row in rows]
        )
        tasks = []
        for row in rows:
            payload = row["task_payload"]
            task = json.loads(payload) if isinstance(payload, str) else payload
            task["_retry_count"] = row["retry_count"]
            task["_operation_id"] = str(row["operation_id"])
            if row["operation_type"]:
                task["operation_type"] = row["operation_type"]
            tasks.append(ClaimedTask(operation_id=str(row["operation_id"]), task_dict=task, schema=schema))
        return tasks


WorkerPoller._claim_batch_for_schema_inner = claim_admitted
main()
