package dev.mote.collector

/** Transport negotiation never treats authorization or size limits as missing protocol support. */
object UploadNegotiation {
    fun unsupported(status: Int) = status == 404 || status == 405
    fun <T, R> sendShrinking(items: List<T>, send: (List<T>) -> Pair<Int, R>): Pair<List<T>, Pair<Int, R>> {
        require(items.isNotEmpty())
        var selected = items
        while (true) {
            val response = send(selected)
            if (response.first != 413 || selected.size == 1) return selected to response
            selected = selected.take((selected.size + 1) / 2)
        }
    }
}
