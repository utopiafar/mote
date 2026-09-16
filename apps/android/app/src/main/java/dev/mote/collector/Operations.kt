package dev.mote.collector

import android.content.Context
import java.io.File

object Operations {
    fun ledger(context: Context) = OperationLedger(File(context.noBackupFilesDir, "operation-ledger.json"))
    fun record(context: Context, kind: OperationKind, reason: OperationReason = OperationReason.NONE, bytes: Long = 0, httpStatus: Int? = null, elapsedMs: Long? = null, recordId: String? = null) {
        runCatching { SupportEvents.runtime(context).operation(kind, reason) }
        try { ledger(context).record(kind, reason, bytes, httpStatus, elapsedMs, recordId) }
        catch (_: Exception) { context.getSharedPreferences("operation-health", 0).edit().putBoolean("incomplete", true).commit() }
        finally { LocalStateChanges.changed() }
    }
    fun httpReason(status: Int) = when (status) { 401, 403 -> OperationReason.AUTH; in 200..299 -> OperationReason.ACK; else -> OperationReason.HTTP }
    fun failure(error: Throwable, stage: EventStage) = when (EventJournal.failure(error, stage)) {
        EventCode.NETWORK -> OperationReason.NETWORK; EventCode.TIMEOUT -> OperationReason.TIMEOUT
        EventCode.STORAGE -> OperationReason.STORAGE; EventCode.CONFIG_INVALID -> OperationReason.CONFIGURATION
        else -> when (stage) { EventStage.MODEL -> OperationReason.MODEL; EventStage.OCR -> OperationReason.OCR; EventStage.PRIVACY -> OperationReason.PRIVACY; EventStage.QUEUE -> OperationReason.STORAGE; else -> OperationReason.RESPONSE }
    }
}
