package dev.mote.collector

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.work.*
import com.android.apksig.ApkVerifier
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Public GitHub metadata/binaries only. No central credentials are read or sent. */
class UpdateNetwork(private val stopped: () -> Boolean = { false }, private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }) {
    @Volatile private var connection: HttpURLConnection? = null
    fun cancel() { connection?.disconnect() }
    fun bytes(url: String, max: Int): ByteArray = response(url).let { r ->
        try { if (r.contentLengthLong > max) throw UpdateFailure("response_size"); r.inputStream.use { input ->
            val out = ByteArrayOutputStream(); val buffer = ByteArray(8192)
            while (true) { checkStopped(); val count = input.read(buffer); if (count < 0) break; if (out.size() + count > max) throw UpdateFailure("response_size"); out.write(buffer, 0, count) }; out.toByteArray()
        } } finally { r.disconnect(); connection = null }
    }
    fun check(config: UpdateConfig): ByteArray {
        config.validate()
        val endpoint = "https://api.github.com/repos/${config.repository}/releases" + if (config.channel == "stable") "/latest" else "?per_page=30"
        val json = AppReleaseVerifier.utf8(bytes(endpoint, 2_000_000))
        val releases = try {
            StrictJson.validate(json)
            if (config.channel == "stable") JSONArray().put(JSONObject(json)) else JSONArray(json)
        } catch (_: Exception) { throw UpdateFailure("response") }
        val versions = (0 until releases.length()).mapNotNull { index ->
            val r = releases.optJSONObject(index) ?: return@mapNotNull null
            val tag = r.optString("tag_name")
            if (r.opt("draft") != false || r.opt("prerelease") != (config.channel == "preview") || !tag.startsWith('v') || !AppReleaseVerifier.validVersion(tag.drop(1))) null else tag.drop(1)
        }
        val version = versions.maxWithOrNull { a, b -> AppReleaseVerifier.compareVersions(a, b) } ?: throw UpdateFailure("not_found")
        return bytes("https://github.com/${config.repository}/releases/download/v$version/mote-release.json", AppReleaseVerifier.MAX_MANIFEST).also { selectedVersion = version }
    }
    var selectedVersion: String? = null; private set
    fun download(asset: AppReleaseAsset, part: File, progress: (Long) -> Unit) {
        if (part.length() > asset.size) part.delete()
        var offset = part.length()
        if (offset < asset.size) {
            val r = response(asset.url, offset)
            try {
                if (r.responseCode == 206) NsfwModelStore.validateRange(r.getHeaderField("Content-Range"), offset, asset.size) else offset = 0
                if (r.contentLengthLong >= 0 && r.contentLengthLong != asset.size - offset) throw UpdateFailure("asset_size")
                if (part.parentFile!!.usableSpace < asset.size - offset + 32L * 1024 * 1024) throw UpdateFailure("storage")
                FileOutputStream(part, offset > 0).use { out -> r.inputStream.use { input ->
                    var total = offset; var last = 0L; val buffer = ByteArray(128 * 1024)
                    while (true) { checkStopped(); val count = input.read(buffer); if (count < 0) break; total += count; if (total > asset.size) throw UpdateFailure("asset_size"); out.write(buffer, 0, count)
                        val now = System.nanoTime(); if (now - last > 250_000_000) { progress(total); last = now }
                    }; out.fd.sync()
                } }
            } finally { r.disconnect(); connection = null }
        }
        checkStopped()
        if (part.length() != asset.size) throw IOException("Incomplete update")
        if (NsfwModelStore.sha256(part) != asset.sha256) { part.delete(); throw UpdateFailure("checksum") }
    }
    private fun checkStopped() { if (stopped()) throw InterruptedIOException("Update cancelled") }
    private fun response(source: String, offset: Long = 0): HttpURLConnection {
        var url = URL(source)
        repeat(6) {
            checkStopped(); validateUrl(url)
            val r = open(url); connection = r
            r.connectTimeout = 15000; r.readTimeout = 20000; r.instanceFollowRedirects = false
            r.setRequestProperty("User-Agent", "Mote-Update/1"); r.setRequestProperty("Accept-Encoding", "identity")
            if (offset > 0) r.setRequestProperty("Range", "bytes=$offset-")
            val code = try { r.responseCode } catch (e: Exception) { r.disconnect(); throw e }
            if (code in setOf(301, 302, 303, 307, 308)) { val location = r.getHeaderField("Location"); r.disconnect(); url = URL(url, location ?: throw UpdateFailure("redirect")) }
            else if (code == 200 || code == 206) return r
            else { r.disconnect(); throw UpdateFailure(when (code) { 404 -> "not_found"; 403, 429 -> "rate_limit"; else -> "network" }) }
        }
        throw UpdateFailure("redirect")
    }
    companion object {
        fun validateUrl(url: URL) { if (url.protocol != "https" || url.port != -1 || url.userInfo != null || url.ref != null || url.host !in setOf("github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")) throw UpdateFailure("host") }
    }
}

object AndroidUpdateVerifier {
    fun installed(context: Context) = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
    fun certificates(context: Context): Set<String> = installed(context).signingInfo?.apkContentsSigners?.map { digest(it.toByteArray()) }?.toSet() ?: emptySet()
    fun verify(context: Context, file: File, asset: AppReleaseAsset, installedVersion: Long = installed(context).longVersionCode) {
        if (asset.packageName != context.packageName) throw UpdateFailure("package")
        if (asset.versionCode <= installedVersion) throw UpdateFailure("not_newer")
        if (certificates(context) != setOf(asset.certificateSha256)) throw UpdateFailure("certificate")
        if (file.length() != asset.size || NsfwModelStore.sha256(file) != asset.sha256) throw UpdateFailure("checksum")
        val result = try { ApkVerifier.Builder(file).setMinCheckedPlatformVersion(Build.VERSION.SDK_INT).setMaxCheckedPlatformVersion(Build.VERSION.SDK_INT).build().verify() } catch (_: Exception) { throw UpdateFailure("apk_signature") }
        if (!result.isVerified || result.signerCertificates.map { digest(it.encoded) }.toSet() != setOf(asset.certificateSha256)) throw UpdateFailure("apk_signature")
        val archive = context.packageManager.getPackageArchiveInfo(file.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES) ?: throw UpdateFailure("package")
        if (archive.packageName != context.packageName || archive.longVersionCode != asset.versionCode || (archive.applicationInfo?.minSdkVersion ?: Int.MAX_VALUE) > Build.VERSION.SDK_INT) throw UpdateFailure("package")
    }
    private fun digest(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it.toInt() and 255) }
}

class AppUpdateStore(val context: Context) {
    val directory = File(context.noBackupFilesDir, "app-updates").apply { mkdirs() }
    val prefs = context.getSharedPreferences("app_updates", Context.MODE_PRIVATE)
    fun config() = UpdateConfig(prefs.getString("repository", "utopiafar/mote")!!, prefs.getString("channel", "stable")!!, prefs.getBoolean("wifiOnly", true))
    fun save(config: UpdateConfig) { config.validate(); prefs.edit().putString("repository", config.repository).putString("channel", config.channel).putBoolean("wifiOnly", config.wifiOnly).commit() }
    fun key() = context.assets.open("release-public-key.pem").bufferedReader().use { it.readText() }
    fun candidate(): Pair<AppRelease, AppReleaseAsset>? {
        val file = File(directory, "manifest.json"); if (!file.exists()) return null
        val release = AppReleaseVerifier.verify(file.readBytes(), key(), config()); return release.asset(context.packageName)?.let { release to it }
    }
    fun deleteDownloadedPackages() {
        // Invalidate queued work before waiting for the active writer; never race installation.
        if (prefs.getBoolean("installRequestActive", false)) throw UpdateFailure("install_pending")
        AppUpdateWork.cancel(context)
        locked { AppUpdateInstaller.withoutActiveInstall(context) {
            val files = directory.listFiles() ?: throw UpdateFailure("storage")
            for (file in files.filter { it.name.matches(Regex("[a-f0-9]{64}\\.(apk|part)")) }) {
                if (!file.delete() && file.exists()) throw UpdateFailure("storage")
            }
            state(if (prefs.getLong("availableCode", 0) > BuildConfig.VERSION_CODE) "available" else "idle", bytes = 0)
        } }
    }
    fun apk(asset: AppReleaseAsset) = File(directory, "${asset.sha256}.apk")
    fun active(id: String) = prefs.getString("operation", "") == id
    fun beginOperation(id: String, action: String) = synchronized(stateLock) { check(prefs.edit().putString("operation", id).putString("action", action).commit()) }
    fun cancelOperation() = synchronized(stateLock) { check(prefs.edit().putString("operation", UUID.randomUUID().toString()).commit()); state("cancelled") }
    fun state(code: String, operation: String? = null, bytes: Long? = null, expectedState: String? = null) = synchronized(stateLock) {
        if (operation != null && !active(operation)) return@synchronized
        if (expectedState != null && prefs.getString("state", "idle") != expectedState) return@synchronized
        prefs.edit().putString("state", code).putLong("changedAt", System.currentTimeMillis()).apply { if (bytes != null) putLong("bytes", bytes) }.commit()
        Unit
    }
    fun publish(raw: ByteArray, release: AppRelease, asset: AppReleaseAsset, operation: String) {
        if (!active(operation)) throw InterruptedIOException()
        val temporary = File(directory, "manifest.tmp"); FileOutputStream(temporary).use { it.write(raw); it.fd.sync() }
        if (!temporary.renameTo(File(directory, "manifest.json"))) throw UpdateFailure("storage")
        directory.listFiles()?.filter { it.name.matches(Regex("[a-f0-9]{64}\\.(apk|part)")) && !it.name.startsWith(asset.sha256) }?.forEach { it.delete() }
        prefs.edit().putString("availableVersion", release.version).putLong("availableCode", asset.versionCode).putLong("size", asset.size).commit()
    }
    fun <T> locked(action: () -> T): T = synchronized(lock) { RandomAccessFile(File(directory, "writer.lock"), "rw").use { it.channel.use { channel -> channel.lock().use { action() } } } }
    companion object { private val lock = Any(); private val stateLock = Any() }
}

class AppUpdateWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    private val store = AppUpdateStore(context)
    private val operation = inputData.getString("operation") ?: ""
    private val network = UpdateNetwork(stopped = { isStopped || !store.active(operation) })
    override fun onStopped() { network.cancel(); super.onStopped() }
    override fun doWork(): Result = try {
        store.locked {
            if (!store.active(operation) || isStopped) return@locked Result.success()
            if (inputData.getString("action") == "check") {
                store.state("checking", operation); val config = store.config(); val raw = network.check(config)
                val release = AppReleaseVerifier.verify(raw, store.key(), config, network.selectedVersion)
                val asset = release.asset(applicationContext.packageName) ?: throw UpdateFailure("asset_missing")
                store.publish(raw, release, asset, operation)
                val state = if (asset.versionCode <= AndroidUpdateVerifier.installed(applicationContext).longVersionCode) "current"
                    else if (AndroidUpdateVerifier.certificates(applicationContext) != setOf(asset.certificateSha256)) "certificate"
                    else if (store.apk(asset).exists()) {
                        try { AndroidUpdateVerifier.verify(applicationContext, store.apk(asset), asset); "ready" }
                        catch (error: UpdateFailure) { if (error.code != "checksum") throw error; store.apk(asset).delete(); "available" }
                    } else "available"
                store.state(state, operation)
            } else {
                val asset = store.candidate()?.second ?: throw UpdateFailure("asset_missing")
                if (asset.versionCode <= AndroidUpdateVerifier.installed(applicationContext).longVersionCode) throw UpdateFailure("not_newer")
                if (AndroidUpdateVerifier.certificates(applicationContext) != setOf(asset.certificateSha256)) throw UpdateFailure("certificate")
                if (store.config().wifiOnly && applicationContext.getSystemService(android.net.ConnectivityManager::class.java).isActiveNetworkMetered) { store.state("waiting_wifi", operation); return@locked Result.retry() }
                val apk = store.apk(asset)
                if (!apk.exists()) { val part = File(store.directory, "${asset.sha256}.part"); store.state("downloading", operation, part.length()); network.download(asset, part) { store.state("downloading", operation, it) }
                    if (!store.active(operation) || isStopped) throw InterruptedIOException()
                    store.state("verifying", operation); AndroidUpdateVerifier.verify(applicationContext, part, asset)
                    if (!part.renameTo(apk)) throw UpdateFailure("storage")
                } else try { AndroidUpdateVerifier.verify(applicationContext, apk, asset) }
                    catch (error: UpdateFailure) { if (error.code == "checksum") apk.delete(); throw error }
                store.state("ready", operation, asset.size)
            }
            SupportEvents.record(applicationContext, EventStage.UPDATE, EventCode.OK); Result.success()
        }
    } catch (_: InterruptedIOException) { store.state(if (isStopped) "waiting_network" else "network", operation); if (isStopped) Result.failure() else Result.retry() }
    catch (e: UpdateFailure) { store.state(e.code, operation); SupportEvents.record(applicationContext, EventStage.UPDATE, EventCode.RESPONSE); if (e.code in setOf("network", "rate_limit")) Result.retry() else Result.failure() }
    catch (_: IOException) { store.state("network", operation); SupportEvents.record(applicationContext, EventStage.UPDATE, EventCode.NETWORK); Result.retry() }
    catch (_: Exception) { store.state("failed", operation); SupportEvents.record(applicationContext, EventStage.UPDATE, EventCode.OTHER); Result.failure() }
}

object AppUpdateWork {
    const val NAME = "mote-app-update"
    fun enqueue(context: Context, action: String) {
        require(action in setOf("check", "download")); val store = AppUpdateStore(context); val id = UUID.randomUUID().toString()
        if (store.prefs.getBoolean("installRequestActive", false)) throw UpdateFailure("install_pending")
        if (action == "download") {
            val asset = store.candidate()?.second ?: throw UpdateFailure("asset_missing")
            if (asset.versionCode <= AndroidUpdateVerifier.installed(context).longVersionCode) throw UpdateFailure("not_newer")
        }
        store.beginOperation(id, action)
        val network = context.getSystemService(android.net.ConnectivityManager::class.java)
        store.state(if (network.activeNetwork == null) "waiting_network" else if (action == "download" && store.config().wifiOnly && network.isActiveNetworkMetered) "waiting_wifi" else "queued", id)
        val request = OneTimeWorkRequestBuilder<AppUpdateWorker>().setInputData(workDataOf("action" to action, "operation" to id))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(if (action == "download" && store.config().wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        try {
            store.prefs.edit().putString("workId", request.id.toString()).commit()
            WorkManager.getInstance(context).enqueueUniqueWork(NAME, ExistingWorkPolicy.REPLACE, request).result.get(10, TimeUnit.SECONDS)
        } catch (error: Exception) { store.state("scheduler", id); throw UpdateFailure("scheduler") }
    }
    fun reconcile(context: Context) {
        val store = AppUpdateStore(context)
        val id = store.prefs.getString("workId", null) ?: return
        val operation = store.prefs.getString("operation", "")!!
        val state = store.prefs.getString("state", "idle")!!
        if (state !in UpdatePresentation.transferStates) return
        val work = WorkManager.getInstance(context).getWorkInfoById(UUID.fromString(id)).get(10, TimeUnit.SECONDS)
        if (store.prefs.getString("workId", null) != id) return
        if (work == null || work.state.isFinished) store.state("scheduler", operation, expectedState = state)
    }
    fun cancel(context: Context) { val store = AppUpdateStore(context); store.cancelOperation(); WorkManager.getInstance(context).cancelUniqueWork(NAME) }
}
