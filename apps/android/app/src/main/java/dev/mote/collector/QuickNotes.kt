package dev.mote.collector

import android.content.Context
import dev.mote.collector.plugins.NotesPlugin

/** Home quick-note surface of the Notes plugin. Draft persistence, attachment
 * originals and both submissions are owned by NotesPlugin; this object keeps
 * the existing call sites for the home composer and diagnostics. */
object QuickNotes {
    internal val io get() = NotesPlugin.io
    internal fun controller(context: Context): NoteDraftController = NotesPlugin.controller(context)
    fun draft(context: Context): NoteDraftStore = NotesPlugin.homeStore(context)
    fun save(context: Context, text: String, mood: String): String = NotesPlugin.saveQuickNote(context, text, mood)
    internal fun save(context: Context, text: String, mood: String, scheduleUpload: (CollectorConfig) -> Unit): String =
        NotesPlugin.saveQuickNote(context, text, mood, scheduleUpload)
}
