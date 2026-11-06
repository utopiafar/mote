package dev.mote.collector

import android.app.Activity
import android.content.Intent
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

/** Every native capture entry pins the actual record read before opening the shared reader. */
internal object CentralCaptureReader {
    fun supports(source: String) = source in setOf("screen","note","activity","ui_page","notification","media","device_event","message")
    fun open(activity: Activity, origin: String, row: JSONObject, conversationId: String? = null, workMemory: WorkMemoryReference? = null, accessGeneration: Long? = null, citationExcerpt: String? = null) {
        val id=row.getString("id"); UUID.fromString(id)
        val version=row.getString("libraryVersion"); require(version.isNotBlank())
        val device=row.getString("deviceId"); require(device.isNotBlank())
        val source=row.getString("source"); require(supports(source))
        val date=Instant.parse(row.getString("capturedAt")).atZone(ZoneId.systemDefault()).toLocalDate().toString()
        activity.startActivity(Intent(activity,CaptureRecordsActivity::class.java)
            .putExtra("recordId",id).putExtra("recordRemote",true).putExtra("recordOrigin",origin)
            .putExtra("recordVersion",version).putExtra("recordDeviceId",device).putExtra("recordObservationCount",LibraryCaptureProjection.observations(row))
            .putExtra("recordSource",source).putExtra("recordDate",date).putExtra("directReader",true).putExtra("centralReaderActions",true)
            .apply {
                conversationId?.let { putExtra("conversationReference",it) }
                citationExcerpt?.takeIf(String::isNotBlank)?.let { putExtra("citationExcerpt",it) }
                workMemory?.let { it.put(this);putExtra("workMemoryGeneration",requireNotNull(accessGeneration));putExtra("workMemoryProcess",WorkMemoryProcess.nonce) }
            })
    }
}
