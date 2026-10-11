package dev.mote.collector

import android.content.Context
import org.json.JSONObject

/** Sending traffic is cancellable independently from central reading, questions and pairing. */
internal class CollectorHttp(private val context: Context) {
    fun post(url: String, body: JSONObject, token: String? = null) = request("POST", url, body, token)
    fun postBytes(url: String, body: ByteArray, token: String? = null, contentType: String) =
        HttpJson.requestBytes("POST", url, body, token, contentType, sendingContext = context)
    fun get(url: String, token: String? = null) = request("GET", url, null, token)
    fun request(method: String, url: String, body: JSONObject?, token: String? = null) =
        HttpJson.requestBytes(method, url, body?.toString()?.toByteArray(Charsets.UTF_8), token, sendingContext = context)
}
