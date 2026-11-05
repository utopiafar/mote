package dev.mote.collector

import android.os.Build
import android.view.View
import android.view.WindowInsets

/**
 * Applies system-bar insets. The main shell asks for the top-bar variant: the platform
 * status-bar frame can also reserve a tall display cutout, while the 56dp bar keeps its
 * interactive content below that cutout and only needs the design's 36dp top area.
 */
fun View.moteInsets(topBar: Boolean = false) {
    val left = paddingLeft; val top = paddingTop; val right = paddingRight; val bottom = paddingBottom
    setOnApplyWindowInsetsListener { view, insets ->
        if (Build.VERSION.SDK_INT >= 30) {
            val bars = insets.getInsets(WindowInsets.Type.systemBars())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            // Target 35+ draws edge-to-edge: adjustResize alone does not move content above the keyboard.
            val keyboard = maxOf(0, ime.bottom - bars.bottom)
            val topInset = if (topBar) HomeFrame.topBarTop(bars.top, resources.displayMetrics.density) else bars.top
            val shell = view as? NativeAppShell
            if (shell != null) {
                shell.systemBars(bars.left, topInset, bars.right, bars.bottom)
                shell.keyboard(keyboard)
            } else {
                view.setPadding(left + bars.left, top + topInset, right + bars.right, bottom + bars.bottom + keyboard)
            }
        } else {
            @Suppress("DEPRECATION") val topInset = if (topBar) HomeFrame.topBarTop(insets.systemWindowInsetTop, resources.displayMetrics.density) else insets.systemWindowInsetTop
            @Suppress("DEPRECATION") view.setPadding(left + insets.systemWindowInsetLeft, top + topInset, right + insets.systemWindowInsetRight, bottom + insets.systemWindowInsetBottom)
        }; insets
    }
}
