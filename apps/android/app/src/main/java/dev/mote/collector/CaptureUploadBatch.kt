package dev.mote.collector

/** Materialize only the records this transport will send in the current turn. */
internal fun DurableQueue.peekUploadBatch(
    remaining: Int,
    packedUpload: Boolean,
    metadataWindowMinutes: Int,
    preferSince: Long?,
) = peekBatch(
    maxCount = if (packedUpload) remaining else 1,
    maxBytes = 4 * 1024 * 1024,
    metadataWindowMinutes = metadataWindowMinutes,
    preferSince = preferSince,
)
