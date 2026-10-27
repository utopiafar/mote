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
            // Target 35+ draws edge-to-edge: adjustResize alone does not move content above the keyboard.
            val keyboard = maxOf(0, ime.bottom - bars.bottom)
            val shell = view as? NativeAppShell
            view.setPadding(left + bars.left, top + bars.top, right + bars.right, bottom + bars.bottom + if (shell == null) keyboard else 0)
            shell?.keyboard(keyboard)
        } else {
            @Suppress("DEPRECATION") view.setPadding(left + insets.systemWindowInsetLeft, top + insets.systemWindowInsetTop, right + insets.systemWindowInsetRight, bottom + insets.systemWindowInsetBottom)
        }; insets
    }
}
