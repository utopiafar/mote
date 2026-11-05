package dev.mote.collector

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermission
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

interface ByteCipher {
    fun seal(bytes: ByteArray): ByteArray
    fun open(bytes: ByteArray): ByteArray
    /** Streams one complete value; length-preserving ciphers override this to avoid buffering. */
    fun seal(input: java.io.InputStream, output: java.io.OutputStream) { output.write(seal(input.readBytes())) }
}

/** The token remains part of the same atomic preference snapshot as its verified owner. */
internal class CredentialValue(private val profile: RuntimeProfile, private val cipher: ByteCipher) {
    fun encode(token: String): String = if (profile.fileCredentials) JSONObject().put("token", token).toString()
        else Base64.getEncoder().encodeToString(cipher.seal(token.toByteArray(Charsets.UTF_8)))
    fun decode(value: String): String = if (profile.fileCredentials) JSONObject(value).let {
        check(it.length() == 1 && it.get("token") is String)
        it.getString("token")
    } else String(cipher.open(Base64.getDecoder().decode(value)), Charsets.UTF_8)
}

/** Reject retired Dev ciphertext without changing or migrating any prior private data. */
internal object DevCredentialFormat {
    private const val MARKER = ".mote-dev-file-credentials"
    fun keyFile(directory: File) = File(directory, "dev-secrets/key.json")
    @Synchronized fun requireCurrent(directory: File, hasConfiguration: Boolean) {
        val marker = File(directory, MARKER)
        if (marker.exists()) {
            check(marker.isFile && marker.readText() == "1") { MoteI18n.text(LocalDataFormat.RESET_MESSAGE) }
            DevSecretKeyFile(keyFile(directory)).read()
            return
        }
        val keyDirectory = keyFile(directory).parentFile!!
        val resumableKey = keyDirectory.isDirectory && !Files.isSymbolicLink(keyDirectory.toPath()) &&
            keyFile(directory).isFile && keyDirectory.listFiles().orEmpty().all {
                it.isFile && !Files.isSymbolicLink(it.toPath()) &&
                    (it.name == "key.json" || (it.name == ".key.lock" && it.length() == 0L))
            }
        check(!hasConfiguration && directory.listFiles().orEmpty().all {
            (it.isFile && (it.name == ".mote-local-format" || it.name in LocalDataFormat.FRAMEWORK_FILES)) ||
                (it == keyDirectory && resumableKey)
        }) { MoteI18n.text(LocalDataFormat.RESET_MESSAGE) }
        check(directory.isDirectory || directory.mkdirs())
        // A process may stop after the atomic key write but before the format marker.
        // Resume only that exact empty, current-format initialization using its existing key.
        if (resumableKey) DevSecretKeyFile(keyFile(directory)).read() else DevSecretKeyFile(keyFile(directory)).initialize()
        FileOutputStream(marker).use { it.write("1".toByteArray()); it.fd.sync() }
    }
}

/** Private state stays authenticated and encrypted; only Dev's key location changes. */
class SecretBox(
    profile: RuntimeProfile = RuntimeProfile.current,
    developmentKeyFile: File? = null,
    protectedCipher: () -> ByteCipher = { KeystoreCipher() }
) : ByteCipher {
    private val delegate: ByteCipher by lazy {
        if (profile.fileCredentials) {
            val file = requireNotNull(developmentKeyFile) { "Dev key file required" }
            val key by lazy { DevSecretKeyFile(file).read() }
            AesGcmCipher { key }
        } else protectedCipher()
    }
    override fun seal(bytes: ByteArray) = delegate.seal(bytes)
    override fun open(bytes: ByteArray) = delegate.open(bytes)
}

internal fun Context.secretBox(): SecretBox {
    LocalDataFormat.requireCurrent(this)
    return SecretBox(developmentKeyFile = DevCredentialFormat.keyFile(noBackupFilesDir))
}

/** A single random Dev AES key, installed atomically and restricted to the app owner. */
internal class DevSecretKeyFile(private val file: File) {
    fun initialize(): SecretKey = synchronized(lock) {
        val directory = requireNotNull(file.parentFile)
        check(!Files.isSymbolicLink(directory.toPath()) && (directory.isDirectory || directory.mkdirs()))
        restrict(directory, directory = true)
        val lockFile = File(directory, ".key.lock")
        check(!Files.isSymbolicLink(lockFile.toPath()))
        FileOutputStream(lockFile, true).use { stream ->
            restrict(lockFile)
            stream.channel.lock().use {
                check(!Files.isSymbolicLink(file.toPath()))
                if (!file.exists()) {
                    val temporary = File.createTempFile("key-", ".tmp", directory)
                    try {
                        restrict(temporary)
                        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
                        val json = JSONObject().put("version", 1).put("algorithm", "AES-256-GCM")
                            .put("key", Base64.getEncoder().encodeToString(key.encoded))
                        FileOutputStream(temporary).use { output -> output.write(json.toString().toByteArray(Charsets.UTF_8)); output.fd.sync() }
                        Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE)
                    } finally { temporary.delete() }
                }
                read()
            }
        }
    }
    fun read(): SecretKey {
        check(file.isFile && !Files.isSymbolicLink(file.toPath()) && file.length() <= 1024) { "Dev secret key missing or invalid" }
        check(Files.getPosixFilePermissions(file.toPath()) == setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE)) { "Dev secret key requires owner-only permissions" }
        val json = JSONObject(file.readText())
        check(json.length() == 3 && json.get("version") == 1 && json.getString("algorithm") == "AES-256-GCM") { "Dev secret key invalid" }
        val bytes = Base64.getDecoder().decode(json.getString("key"))
        check(bytes.size == 32) { "Dev secret key invalid" }
        return SecretKeySpec(bytes, "AES")
    }
    private fun restrict(path: File, directory: Boolean = false) {
        check(path.setReadable(false, false) && path.setWritable(false, false) && path.setExecutable(false, false))
        check(path.setReadable(true, true) && path.setWritable(true, true) && (!directory || path.setExecutable(true, true)))
    }
    companion object { private val lock = Any() }
}

private class KeystoreCipher : ByteCipher {
    private val cipher = AesGcmCipher { key() }
    private fun key(): SecretKey = synchronized(SecretBox::class.java) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("mote.private.v1", null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder("mote.private.v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    override fun seal(bytes: ByteArray) = cipher.seal(bytes)
    override fun open(bytes: ByteArray) = cipher.open(bytes)
}

private class AesGcmCipher(private val key: () -> SecretKey) : ByteCipher {
    override fun seal(bytes: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return byteArrayOf(cipher.iv.size.toByte()) + cipher.iv + cipher.doFinal(bytes)
    }
    override fun open(bytes: ByteArray): ByteArray {
        require(bytes.isNotEmpty())
        val length = bytes[0].toInt()
        require(length in 12..16 && bytes.size > length + 1)
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, length + 1)))
            doFinal(bytes.copyOfRange(length + 1, bytes.size))
        }
    }
}
