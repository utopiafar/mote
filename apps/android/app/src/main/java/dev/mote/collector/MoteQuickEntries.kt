package dev.mote.collector

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.os.Bundle
import android.view.View
import dev.mote.collector.plugins.SystemEntriesPlugin

/**
 * One definition for every system-level entry: launcher shortcuts, the capture notification and the widget.
 * Entries only open the app's own editor or Ask page; they never save, send or start capture by themselves.
 * The system entries plugin decides whether they are offered at all.
 */
internal enum class MoteQuickEntry(val id: String, val labelKey: String, val icon: Int) {
    RECORD("record", "记录", R.drawable.ic_entry_record),
    PHOTO("photo", "拍照", R.drawable.ic_entry_photo),
    AUDIO("audio", "录音", R.drawable.ic_entry_audio),
    ASK("ask", "问一问", R.drawable.ic_entry_ask);

    val label get() = MoteI18n.text(labelKey)
    fun intent(context: Context): Intent = Intent(context, QuickEntryActivity::class.java).setAction(ACTION).putExtra(EXTRA, id)
    fun pendingIntent(context: Context): PendingIntent? =
        if (!SystemEntriesPlugin.availability(context).active) null
        else PendingIntent.getActivity(context, 200 + ordinal, intent(context), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    /** The in-app destination. A new task is required because entries start outside an activity. */
    fun destination(context: Context): Intent = when (this) {
        ASK -> Intent(context, MainActivity::class.java).putExtra("page", "ASK")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        else -> Intent(context, if (this == AUDIO) MicrophoneRecordEditorActivity::class.java else RecordEditorActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .apply { media?.let { putExtra("startMedia", it) } }
    }
    val media get() = when (this) { PHOTO -> "camera"; AUDIO -> "audio"; else -> null }

    companion object {
        const val ACTION = "dev.mote.collector.action.QUICK_ENTRY"
        const val EXTRA = "entry"
        fun find(id: String?) = entries.find { it.id == id }
    }
}

/** Launcher shortcuts follow the app language; publishing failures leave the app unchanged. */
internal object MoteShortcuts {
    fun publish(context: Context) {
        val manager = context.getSystemService(ShortcutManager::class.java) ?: return
        val availability = SystemEntriesPlugin.availability(context)
        runCatching {
            manager.dynamicShortcuts = SystemEntriesPlugin.quickEntries(availability).map { entry ->
                ShortcutInfo.Builder(context, entry.id).setShortLabel(entry.label).setLongLabel(entry.label)
                    .setIcon(Icon.createWithResource(context, entry.icon)).setIntent(entry.intent(context)).build()
            }
        }
    }
}

/**
 * Launchers start shortcuts with a cleared task. Entries land here in their own task and forward to the app,
 * so drafts, the Ask page and any reader position in the app's existing task are kept.
 */
class QuickEntryActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val availability = SystemEntriesPlugin.availability(this)
        if (!availability.active) {
            android.widget.Toast.makeText(this, availability.reason ?: MoteI18n.text("快捷入口不可用"), android.widget.Toast.LENGTH_LONG).show()
            finish()
            return
        }
        MoteQuickEntry.find(intent.getStringExtra(MoteQuickEntry.EXTRA)).takeIf { intent.action == MoteQuickEntry.ACTION }?.let { entry ->
            runCatching { getSystemService(ShortcutManager::class.java)?.reportShortcutUsed(entry.id) }
            startActivity(entry.destination(this))
        }
        finish()
    }
}

/** A one-row home-screen entry built from the same definitions. It reads nothing and shows no captured content. */
class QuickEntryWidget : android.appwidget.AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: android.appwidget.AppWidgetManager, ids: IntArray) = update(context, manager, ids)
    companion object {
        fun refresh(context: Context) {
            val manager = android.appwidget.AppWidgetManager.getInstance(context) ?: return
            val ids = manager.getAppWidgetIds(android.content.ComponentName(context, QuickEntryWidget::class.java))
            if (ids.isNotEmpty()) update(context, manager, ids)
        }
        private fun update(context: Context, manager: android.appwidget.AppWidgetManager, ids: IntArray) = manager.updateAppWidget(ids, views(context))
        internal fun views(context: Context) = android.widget.RemoteViews(context.packageName, R.layout.widget_quick_entries).apply {
            val availability = SystemEntriesPlugin.availability(context)
            if (!availability.active) {
                setTextViewText(R.id.widget_ask, availability.reason ?: MoteI18n.text("快捷入口不可用"))
                setContentDescription(R.id.widget_ask, availability.reason ?: MoteI18n.text("快捷入口不可用"))
                listOf(R.id.widget_record, R.id.widget_photo, R.id.widget_audio).forEach { setViewVisibility(it, View.GONE) }
                setOnClickPendingIntent(R.id.widget_ask, null)
                return@apply
            }
            setTextViewText(R.id.widget_ask, MoteI18n.text("问一问"))
            setContentDescription(R.id.widget_ask, MoteQuickEntry.ASK.label)
            setOnClickPendingIntent(R.id.widget_ask, MoteQuickEntry.ASK.pendingIntent(context))
            listOf(R.id.widget_record to MoteQuickEntry.RECORD, R.id.widget_photo to MoteQuickEntry.PHOTO, R.id.widget_audio to MoteQuickEntry.AUDIO).forEach { (view, entry) ->
                setContentDescription(view, entry.label); setOnClickPendingIntent(view, entry.pendingIntent(context))
            }
        }
    }
}

/** Republishes the system surfaces after the app starts or its language changes. */
internal object MoteSystemEntries {
    fun refresh(context: Context) {
        val availability = SystemEntriesPlugin.availability(context)
        MoteShortcuts.publish(context)
        runCatching { QuickEntryWidget.refresh(context) }
        if (availability.active) runCatching { android.service.quicksettings.TileService.requestListeningState(context, android.content.ComponentName(context, ScreenCaptureTileService::class.java)) }
    }
}
