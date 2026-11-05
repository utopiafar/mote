package dev.mote.collector.recording

import dev.mote.collector.RecordDraftStore
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Moves finished or recovered segment files into the single retained draft.
 * The staged ID comes from the segment path, so retrying after a kill replaces
 * the same attachment instead of adding a duplicate.
 */
internal class RecordingDraftSink(private val store: RecordDraftStore) {
    fun commit(segment: SegmentedAudioWriter.Segment): JSONObject {
        val item = store.stageFile(segment.file, segment.file.name, MIME, stagedId(segment.file))
        store.attach(item)
        segment.file.delete()
        return item
    }

    /** Stages segments left behind by a killed process, in recording order. */
    fun recover(directory: File): List<JSONObject> = directory.listFiles().orEmpty()
        .filter { it.isFile && it.name.startsWith(SegmentedAudioWriter.SEGMENT_PREFIX) && it.name.endsWith(".aac") }
        .sortedBy { it.name }
        .mapNotNull { file ->
            if (!AdtsFrames.hasCompleteFrame(file)) {
                file.delete()
                return@mapNotNull null
            }
            val item = store.stageFile(file, file.name, MIME, stagedId(file))
            store.attach(item)
            file.delete()
            item
        }

    internal companion object {
        const val MIME = "audio/aac"

        fun stagedId(file: File): String =
            UUID.nameUUIDFromBytes(file.canonicalPath.toByteArray(Charsets.UTF_8)).toString()
    }
}
