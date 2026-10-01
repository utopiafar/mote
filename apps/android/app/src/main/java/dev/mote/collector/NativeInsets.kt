package dev.mote.collector

import android.os.Build
import android.view.View
import android.view.WindowInsets

fun View.moteInsets() {
    val left = paddingLeft; val top = paddingTop; val right = paddingRight; val bottom = paddingBottom
    setOnApplyWindowInsetsListener { view, insets ->
        if (Build.VERSION.SDK_INT >= 30) {
            val bars = insets.getInsets(WindowInsets.Type.systemBars())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            // Target 35+ draws edge-to-edge: adjustResize alone does not keep app navigation above the keyboard.
            view.setPadding(left + bars.left, top + bars.top, right + bars.right, bottom + maxOf(bars.bottom, ime.bottom))
        } else {
            @Suppress("DEPRECATION") view.setPadding(left + insets.systemWindowInsetLeft, top + insets.systemWindowInsetTop, right + insets.systemWindowInsetRight, bottom + insets.systemWindowInsetBottom)
        }; insets
    }
}
