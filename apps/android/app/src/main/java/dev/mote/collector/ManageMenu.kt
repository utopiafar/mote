package dev.mote.collector

/** My Mote shows the two owner switches; the screen row yields to a permission step when its source cannot run. */
internal data class ManageMenuState(val screenOn: Boolean, val sendOn: Boolean, val screenPermission: Boolean)

internal object ManageMenu {
    fun state(captureEnabled: Boolean, screenSelected: Boolean, screenLive: Boolean, sendPaused: Boolean) =
        ManageMenuState(
            screenOn = captureEnabled && screenSelected,
            sendOn = !sendPaused,
            screenPermission = captureEnabled && screenSelected && !screenLive,
        )

    /** A projection session needs new system consent; accessibility capture points at the permission page. */
    fun screenPermissionAction(projection: Boolean) =
        if (projection) CaptureOverview.Action.RESTART else CaptureOverview.Action.PERMISSIONS
}
