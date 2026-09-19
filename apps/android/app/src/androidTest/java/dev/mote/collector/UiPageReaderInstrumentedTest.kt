package dev.mote.collector

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Entirely synthetic nodes: never queries a real app, screenshot, or personal content. */
@RunWith(AndroidJUnit4::class)
class UiPageReaderInstrumentedTest {
    @Suppress("DEPRECATION")
    private fun node()=AccessibilityNodeInfo.obtain().apply { packageName="fixture";className="android.widget.TextView";text="Generated fixture text";isVisibleToUser=true;setBoundsInScreen(Rect(10,10,80,30)) }
    private fun read(n: AccessibilityNodeInfo, masks: List<Rect> = emptyList(), occluded: List<Rect> = emptyList())=UiPageReader.read(n,"fixture","1","fixture.Page",Rect(0,0,100,100),masks,occluded)
    @Test fun sensitiveAndHiddenContentNeverLeavesReader() {
        assertEquals("Generated fixture text",read(node()).getJSONArray("nodes").getJSONObject(0).getString("text"))
        for(n in listOf(node().apply{isPassword=true},node().apply{isEditable=true},node().apply{isVisibleToUser=false},node().apply{packageName="foreign"}))assertEquals(0,read(n).getJSONArray("nodes").length())
        assertEquals("",read(node(),listOf(Rect(0,0,20,20))).getJSONArray("nodes").getJSONObject(0).getString("text"))
        assertEquals("",read(node(),occluded=listOf(Rect(0,0,20,20))).getJSONArray("nodes").getJSONObject(0).getString("text"))
        val large=read(node().apply{text="x".repeat(2001)})
        assertTrue(large.getBoolean("truncated"));assertEquals("",large.getJSONArray("nodes").getJSONObject(0).getString("text"))
    }
}
