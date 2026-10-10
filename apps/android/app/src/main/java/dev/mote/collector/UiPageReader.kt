package dev.mote.collector

import android.graphics.Rect
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

internal object UiPageReader {
    private const val MAX_DEPTH = 32
    /** Runs on one bounded worker. Sensitive subtrees are skipped before reading text. */
    fun read(root: AccessibilityNodeInfo, appId: String, version: String, activity: String, viewport: Rect, masks: List<Rect>, occlusions: List<Rect>): JSONObject {
        val nodes=JSONArray(); var count=0; var chars=0; var truncated=false
        val deadline=SystemClock.elapsedRealtime()+750
        fun visit(n: AccessibilityNodeInfo, parent: String?, depth: Int, childIndex: Int) {
            if (count>=256 || depth>MAX_DEPTH || SystemClock.elapsedRealtime()>deadline) { truncated=true; return }; count++
            if (n.packageName?.toString()!=appId || !n.isVisibleToUser || n.isPassword || n.isEditable) return
            if (android.os.Build.VERSION.SDK_INT>=34 && n.isAccessibilityDataSensitive) return
            val bounds=Rect(); n.getBoundsInScreen(bounds)
            if (bounds.isEmpty || !Rect.intersects(viewport,bounds)) return
            val id=count.toString(); var text=""
            if (viewport.contains(bounds) && masks.none { Rect.intersects(it,bounds) } && occlusions.none { Rect.intersects(it,bounds) }) {
                val raw=n.text?.toString().orEmpty() // Content descriptions can duplicate hidden descendants; not captured.
                // Keep long visible paragraphs; only the shared page budget may truncate.
                val remaining = 32000 - chars
                var end = minOf(raw.length, remaining)
                if (end in 1 until raw.length && raw[end - 1].isHighSurrogate() && raw[end].isLowSurrogate()) end--
                text = raw.substring(0, end); chars += text.length
                if (end < raw.length) truncated = true
            }
            nodes.put(JSONObject().put("id",id).put("parentId",parent).put("childIndex",childIndex).put("resourceId",n.viewIdResourceName.orEmpty().take(300))
                .put("role",n.className?.toString().orEmpty().take(300)).put("text",text)
                .put("bounds",JSONObject().put("x",bounds.left).put("y",bounds.top).put("width",bounds.width()).put("height",bounds.height())))
            val children=n.childCount
            for(i in 0 until children.coerceAtMost(256)) {
                if(count>=256 || SystemClock.elapsedRealtime()>deadline){truncated=true;break}
                val child=n.getChild(i)?:continue
                try{visit(child,id,depth+1,i)}finally{@Suppress("DEPRECATION") child.recycle()}
            }
            if(children>256)truncated=true
        }
        visit(root,null,0,0)
        return JSONObject().put("appId",appId).put("appVersion",version.take(300)).put("activity",activity.take(300)).put("nodes",nodes).put("truncated",truncated)
    }
}
