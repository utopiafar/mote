package dev.mote.collector

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** U7: FileView is the only availability source for the Android library. A
 * label or URI never becomes an original-open permission. */
class FileViewPresentationTest {
    private val id = "35b8fadb-8f0a-4769-8545-cdad61c4041d"

    private fun coverage(status: String, completed: Long? = null, total: Long? = null) = JSONObject().put("status", status).apply {
        if (completed != null) put("completed", completed).put("total", total)
    }

    private fun view(retention: String = "snapshot", hasOriginal: Boolean = false, canOpenOriginal: Boolean = false,
                     originMissing: Boolean = false, extraction: JSONObject = coverage("pending")) = CentralFileView.read(
        JSONObject().put("captureId", id).put("sourceId", "source").put("retention", retention)
            .put("item", JSONObject().put("kind", "file").put("externalId", "generated.txt").put("revision", "v1"))
            .put("hasOriginal", hasOriginal).put("originMissing", originMissing).put("canOpenOriginal", canOpenOriginal)
            .put("coverage", JSONObject().put("extraction", extraction)
                .put("semantic", coverage("pending")).put("embedding", coverage("unsupported"))),
    )

    @Test fun referenceRetentionNeverClaimsBodyOrOriginal() {
        val summary = FileViewPresentation.summary(view(retention = "reference", extraction = coverage("unsupported")))
        assertEquals("仅引用 · 不读取正文", summary.retention)
        assertFalse(FileViewPresentation.capabilities(view(retention = "reference")).body)
        assertFalse(FileViewPresentation.capabilities(view(retention = "reference")).original)
        assertEquals("未保留原件", summary.original)
        assertTrue(summary.lines.contains("正文提取 · 不支持"))
    }

    @Test fun snapshotRetainsBodyButReleasesTheOriginal() {
        val snapshot = view(extraction = coverage("partial", 2, 3))
        val summary = FileViewPresentation.summary(snapshot)
        assertTrue(FileViewPresentation.capabilities(snapshot).body)
        assertFalse(FileViewPresentation.capabilities(snapshot).original)
        assertEquals("正文快照", summary.retention)
        assertEquals("未保留原件", summary.original)
        assertEquals("部分 2/3", summary.body)
    }

    @Test fun archiveOriginalStillRequiresTheServerCapability() {
        val disabled = view(retention = "archive", hasOriginal = true, canOpenOriginal = false)
        assertEquals("原件不可用", FileViewPresentation.summary(disabled).original)
        assertFalse(FileViewPresentation.capabilities(disabled).original)
        val enabled = view(retention = "archive", hasOriginal = true, canOpenOriginal = true, extraction = coverage("ready"))
        assertEquals("可打开原件", FileViewPresentation.summary(enabled).original)
        assertTrue(FileViewPresentation.capabilities(enabled).original)
        assertTrue(FileViewPresentation.capabilities(enabled).body)
    }

    @Test fun originMissingIsSeparateFromOriginalAvailability() {
        val summary = FileViewPresentation.summary(view(retention = "archive", hasOriginal = true, canOpenOriginal = true, originMissing = true))
        assertTrue(summary.lines.contains("原位置已不可见"))
        assertEquals("可打开原件", summary.original)
    }

    @Test fun capabilityChangesProduceANewRefreshSignature() {
        val closed = FileViewPresentation.summary(view(retention = "archive", hasOriginal = true, canOpenOriginal = false))
        val opened = FileViewPresentation.summary(view(retention = "archive", hasOriginal = true, canOpenOriginal = true))
        assertNotEquals(closed.signature, opened.signature)
        assertEquals(closed.signature, FileViewPresentation.summary(view(retention = "archive", hasOriginal = true, canOpenOriginal = false)).signature)
    }

    @Test fun availabilityRefreshReloadsOnlyForAChangedViewOrRevocation() {
        val closed = view(retention = "archive", hasOriginal = true, canOpenOriginal = false)
        val opened = view(retention = "archive", hasOriginal = true, canOpenOriginal = true)
        assertFalse(FileViewPresentation.shouldReload(FileViewPresentation.summary(closed).signature, closed))
        assertTrue(FileViewPresentation.shouldReload(FileViewPresentation.summary(closed).signature, opened))
        assertFalse("A transient failure keeps the current body", FileViewPresentation.shouldReload(FileViewPresentation.summary(closed).signature, null))
        assertTrue(FileViewPresentation.revoked(CentralFailure(403)))
        assertTrue(FileViewPresentation.revoked(CentralFailure(410)))
        assertFalse(FileViewPresentation.revoked(java.io.IOException("generated offline")))
    }

    @Test fun aDetailViewMustDescribeTheSameCaptureAndRevision() {
        val detail = JSONObject().put("captureId", id).put("item", JSONObject().put("revision", "v1"))
        assertEquals(id, CentralFileView.forDetail(detail, JSONObject().put("captureId", id).put("sourceId", "source")
            .put("retention", "snapshot").put("item", JSONObject().put("kind", "file").put("externalId", "generated.txt").put("revision", "v1"))
            .put("hasOriginal", false).put("originMissing", false).put("canOpenOriginal", false)
            .put("coverage", JSONObject().put("extraction", coverage("pending")).put("semantic", coverage("pending")).put("embedding", coverage("pending"))))!!.captureId)
        assertNull(CentralFileView.forDetail(detail, JSONObject().put("captureId", id).put("sourceId", "source")
            .put("retention", "snapshot").put("item", JSONObject().put("kind", "file").put("externalId", "generated.txt").put("revision", "other"))
            .put("hasOriginal", false).put("originMissing", false).put("canOpenOriginal", false)
            .put("coverage", JSONObject().put("extraction", coverage("pending")).put("semantic", coverage("pending")).put("embedding", coverage("pending")))))
    }
}
