package dev.mote.collector.plugins

import dev.mote.collector.CentralClient
import dev.mote.collector.CentralFailure
import dev.mote.collector.FileViewPresentation
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The plugin owns the pinned read path: exact pages and ranges from the real
 * client shape, and no body after the selection is withdrawn. */
class NativeLibraryPluginTest {
    private val origin = "https://central.invalid"
    private val material = "mat_" + "a".repeat(64)
    private val revision = "b".repeat(64)
    private val request = LibraryReader.Request(origin = origin, type = "material", source = material, revision = revision)

    private fun materialPage(text: String, offset: Int, nextOffset: Int?) = JSONObject()
        .put("material", JSONObject().put("ref", "material:$material@$revision").put("id", material).put("revision", revision)
            .put("title", "Generated pinned material").put("sequence", 1).put("blockCount", 1).put("assetCount", 0)
            .put("retention", JSONObject().put("original", "retained")))
        .put("text", text).put("textRange", JSONObject().put("offset", offset).put("total", 40).put("nextOffset", nextOffset ?: JSONObject.NULL))
        .put("spans", JSONArray())

    private fun client(read: (String) -> JSONObject = { materialPage("Generated exact page one", 0, 20) }, onMembers: (() -> Unit)? = null) = CentralClient(origin, "generated-token", transport = { _, url, _, _, _ ->
        when {
            url.contains("/read?") -> 200 to read(url)
            url.contains("/members?") -> { onMembers?.invoke(); 200 to JSONObject().put("items", JSONArray()).put("nextOffset", JSONObject.NULL).put("total", 0) }
            else -> 404 to JSONObject().put("error", "not_found")
        }
    })

    private class Holder(var access: LibraryReader.Access)

    @Test fun builtinProviderRegistersTheLibraryScope() {
        val registry = NativePluginRegistry().apply { NativeLibraryPlugin.register(this, "generated-build") }
        assertEquals(PluginAvailability.ACTIVE, registry.availability(NativeLibraryPlugin.requirement()))
        assertNotNull(registry.provider(NativeLibraryPlugin.CAPABILITY, NativeLibraryPlugin.API_VERSION))
    }

    @Test fun stoppedScopeOwnsNoLibrarySurface() {
        val registry = NativePluginRegistry().apply { NativeLibraryPlugin.register(this, "generated-build") }
        val host = NativePluginHost(registry)
        val identity = PluginInstanceIdentity(NativeLibraryPlugin.INSTANCE_ID, "generated-installation", NativeLibraryPlugin.INSTANCE_ID)
        val scope = (host.createScope(PluginInstanceDescriptor(identity, setOf(NativeLibraryPlugin.CAPABILITY), requires = listOf(NativeLibraryPlugin.requirement()))) as PluginResult.Ok).value
        val owner = NativeLibraryPlugin.open(host, scope)
        assertEquals(
            setOf("library.browse", "library.reader", "library.sources", "library.memory-topics"),
            host.scope(NativeLibraryPlugin.INSTANCE_ID)!!.services.keys,
        )
        assertTrue(owner.active)
        host.stopScope(NativeLibraryPlugin.INSTANCE_ID)
        assertFalse(owner.active)
    }

    @Test fun exactMaterialPagesKeepTheirReportedRangeAndContinuation() {
        val holder = Holder(LibraryReader.Access(origin, 1, client(read = { url ->
            if (url.contains("offset=20")) materialPage("Generated exact page two", 20, null)
            else materialPage("Generated exact page one", 0, 20)
        })))
        val reader = NativeLibraryPlugin.reader { holder.access }
        val first = reader.open(request) as LibraryReader.Available
        assertEquals("Generated exact page one", first.page.text)
        assertEquals(0, first.page.range!!.getInt("offset"))
        assertEquals(40, first.page.range.getInt("total"))
        assertEquals(20, first.page.nextOffset)

        val second = reader.open(request, offset = first.page.nextOffset!!) as LibraryReader.Available
        assertEquals("Generated exact page two", second.page.text)
        assertEquals(20, second.page.range!!.getInt("offset"))
        assertNull(second.page.nextOffset)
    }

    @Test fun withdrawnSelectionReturnsUnreadableWithoutABody() {
        val holder = Holder(LibraryReader.Access(origin, 1, client()))
        val reader = NativeLibraryPlugin.reader { holder.access }
        assertTrue(reader.open(request) is LibraryReader.Available)
        holder.access = LibraryReader.Access(origin, 2, null)
        val revoked = reader.open(request)
        assertSame(LibraryReader.Unreadable, revoked)
        assertTrue(reader.unreadable(request))
        assertNull((revoked as? LibraryReader.Available)?.page)
    }

    @Test fun revocationDuringReadDiscardsTheCompletedBody() {
        val holder = Holder(LibraryReader.Access(origin, 1, client()))
        val reader = NativeLibraryPlugin.reader { holder.access }
        holder.access = LibraryReader.Access(origin, 1, client(onMembers = {
            holder.access = LibraryReader.Access(origin, 2, null)
        }))
        val result = reader.open(request)
        assertSame("a body completed under a withdrawn selection is never published", LibraryReader.Unreadable, result)
        assertNull((result as? LibraryReader.Available)?.page)
    }

    @Test fun originalPageCarriesTheExactFileViewAndRejectsAChangedRevision() {
        val capture = "35b8fadb-8f0a-4769-8545-cdad61c4041d"
        val source = "generated-source"; val external = "generated.txt"; val revision = "c".repeat(64)
        fun view(itemRevision: String = revision) = JSONObject().put("captureId", capture).put("sourceId", source).put("retention", "archive")
            .put("item", JSONObject().put("kind", "file").put("externalId", external).put("revision", itemRevision))
            .put("hasOriginal", true).put("originMissing", false).put("canOpenOriginal", true)
            .put("coverage", JSONObject().put("extraction", JSONObject().put("status", "ready"))
                .put("semantic", JSONObject().put("status", "pending")).put("embedding", JSONObject().put("status", "unsupported")))
        val client = CentralClient(origin, "generated-token", transport = { _, url, _, _, _ ->
            when {
                url.contains("/view") -> 200 to view()
                url.contains("/api/files/") -> 200 to JSONObject().put("captureId", capture)
                    .put("item", JSONObject().put("kind", "file").put("externalId", external).put("revision", revision))
                    .put("hasOriginal", true)
                url.contains("/api/capture-browser/") -> 200 to JSONObject().put("id", capture).put("deviceId", "generated-phone")
                    .put("provenance", JSONObject().put("sourceId", source).put("externalId", external).put("revision", revision))
                    .put("fileArchive", JSONObject())
                url.contains("/history") -> 200 to JSONObject().put("items", JSONArray())
                else -> 404 to JSONObject().put("error", "not_found")
            }
        })
        val reader = NativeLibraryPlugin.reader { LibraryReader.Access(origin, 1, client) }
        val request = LibraryReader.Request(origin = origin, type = "original", source = source, external = external,
            device = "generated-phone", revision = revision, capture = capture)
        val page = (reader.open(request) as LibraryReader.Available).page
        assertEquals(capture, page.fileView!!.captureId)
        assertTrue(page.fileView.canOpenOriginal)
        assertTrue(FileViewPresentation.capabilities(page.fileView).original)
        assertEquals(capture, reader.view(request)!!.captureId)

        val stale = CentralClient(origin, "generated-token", transport = { _, url, _, _, _ ->
            when {
                url.contains("/view") -> 200 to view("d".repeat(64))
                url.contains("/api/files/") -> 200 to JSONObject().put("captureId", capture)
                    .put("item", JSONObject().put("kind", "file").put("externalId", external).put("revision", revision)).put("hasOriginal", true)
                url.contains("/api/capture-browser/") -> 200 to JSONObject().put("id", capture).put("deviceId", "generated-phone")
                    .put("provenance", JSONObject().put("sourceId", source).put("externalId", external).put("revision", revision)).put("fileArchive", JSONObject())
                else -> 200 to JSONObject().put("items", JSONArray())
            }
        })
        val staleReader = NativeLibraryPlugin.reader { LibraryReader.Access(origin, 1, stale) }
        assertTrue(staleReader.open(request) is LibraryReader.Failed)
    }

    @Test fun withdrawnSelectionHasNoFileCapability() {
        val capture = "35b8fadb-8f0a-4769-8545-cdad61c4041d"
        val request = LibraryReader.Request(origin = origin, type = "original", capture = capture)
        val holder = Holder(LibraryReader.Access(origin, 1, client()))
        val reader = NativeLibraryPlugin.reader { holder.access }
        holder.access = LibraryReader.Access(origin, 2, null)
        assertNull(reader.view(request))
        val denied = CentralClient(origin, "generated-token", transport = { _, _, _, _, _ -> 403 to JSONObject().put("reason", "forbidden") })
        val deniedReader = NativeLibraryPlugin.reader { LibraryReader.Access(origin, 1, denied) }
        val error = runCatching { deniedReader.view(request) }.exceptionOrNull()
        assertTrue(error is CentralFailure && error.status == 403)
        assertTrue(FileViewPresentation.revoked(error))
    }

    @Test fun localRetainedOriginalStaysReadableWithoutCentralAuthorization() {
        val reader = LibraryReader({ LibraryReader.Access("", 4, null) }) { _, offset ->
            LibraryReader.localPage(
                dev.mote.collector.LibraryLocalSources.Pinned(JSONObject().put("title", "Generated local original"), "Generated local body"),
                offset,
            )
        }
        val page = (reader.open(LibraryReader.Request(source = "generated-source", external = "generated-external", revision = "generated-revision", local = true)) as LibraryReader.Available).page
        assertEquals("Generated local body", page.text)
        assertFalse(reader.unreadable(LibraryReader.Request(source = "generated-source", local = true)))
    }
}
