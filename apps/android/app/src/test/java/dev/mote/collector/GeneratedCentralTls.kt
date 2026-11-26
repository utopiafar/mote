package dev.mote.collector

import java.io.File
import java.net.InetAddress
import java.nio.file.Files
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory

/** Real loopback TLS for host tests that also run against the release APK profile. */
internal class GeneratedCentralTls(backlog: Int) : AutoCloseable {
    private val previousFactory = HttpsURLConnection.getDefaultSSLSocketFactory()
    val server = contexts.first.serverSocketFactory.createServerSocket(0, backlog, InetAddress.getByName(host))
    val origin = "https://$host:${server.localPort}"

    init {
        HttpsURLConnection.setDefaultSSLSocketFactory(contexts.second.socketFactory)
    }

    override fun close() {
        try {
            server.close()
        } finally {
            HttpsURLConnection.setDefaultSSLSocketFactory(previousFactory)
        }
    }

    private companion object {
        const val host = "127.0.0.1"
        val contexts by lazy {
            val directory = Files.createTempDirectory("mote-generated-tls-").toFile()
            try {
                val file = directory.resolve("server.p12")
                val log = directory.resolve("keytool.log")
                val password = UUID.randomUUID().toString()
                val process = ProcessBuilder(
                    File(System.getProperty("java.home"), "bin/keytool").absolutePath,
                    "-genkeypair", "-alias", "fixture", "-dname", "CN=$host", "-ext", "SAN=ip:$host",
                    "-keyalg", "RSA", "-keysize", "2048", "-validity", "1", "-storetype", "PKCS12",
                    "-keystore", file.absolutePath, "-storepass", password, "-noprompt",
                ).redirectErrorStream(true).redirectOutput(log).start()
                if (!process.waitFor(10, TimeUnit.SECONDS)) {
                    process.destroyForcibly()
                    error("Generated loopback TLS key creation timed out")
                }
                check(process.exitValue() == 0) { log.readText() }
                val keys = KeyStore.getInstance("PKCS12").apply {
                    file.inputStream().use { load(it, password.toCharArray()) }
                }
                val trust = KeyStore.getInstance("PKCS12").apply {
                    load(null, null)
                    setCertificateEntry("fixture", keys.getCertificate("fixture"))
                }
                val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
                    init(keys, password.toCharArray())
                }
                val trustManagers = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
                    init(trust)
                }
                SSLContext.getInstance("TLS").apply { init(keyManagers.keyManagers, null, null) } to
                    SSLContext.getInstance("TLS").apply { init(null, trustManagers.trustManagers, null) }
            } finally {
                directory.deleteRecursively()
            }
        }
    }
}
