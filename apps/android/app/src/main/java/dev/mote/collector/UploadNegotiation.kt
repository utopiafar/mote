package dev.mote.collector

/** Only an explicit size limit shrinks a bundle; all other rejections preserve the pending records. */
object UploadNegotiation {
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
