package dev.mote.collector.recording

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class RecordingServiceTest {
    @Test fun `waveform follows captured sound and stays quiet for silence`() {
        val silence = recordingLevel(shortArrayOf(0, 0, 0), 3)
        val quiet = recordingLevel(shortArrayOf(0, -900, 0), 3)
        val loud = recordingLevel(shortArrayOf(0, 9000, 0), 3)
        assertEquals(0f, silence, 0f)
        assertTrue(quiet > silence && quiet < loud)
        assertEquals(1f, loud, 0f)
        assertEquals(0f, recordingLevel(shortArrayOf(0, Short.MIN_VALUE), 1), 0f)
        assertEquals(1f, recordingLevel(shortArrayOf(Short.MIN_VALUE), 1), 0f)
    }
    @Test fun `manifest grants microphone foreground access and keeps service private`() {
        val file = listOf(File("src/main/AndroidManifest.xml"), File("app/src/main/AndroidManifest.xml")).first { it.isFile }
        val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(file)
        val android = "http://schemas.android.com/apk/res/android"
        val permissions = document.getElementsByTagName("uses-permission")
        assertTrue((0 until permissions.length).any { permissions.item(it).attributes.getNamedItemNS(android, "name")?.nodeValue == "android.permission.FOREGROUND_SERVICE_MICROPHONE" })
        val services = document.getElementsByTagName("service")
        val service = (0 until services.length).map { services.item(it) }.single { it.attributes.getNamedItemNS(android, "name")?.nodeValue == ".recording.RecordingService" }
        assertEquals("microphone", service.attributes.getNamedItemNS(android, "foregroundServiceType").nodeValue)
        assertEquals("false", service.attributes.getNamedItemNS(android, "exported").nodeValue)
        val activities = document.getElementsByTagName("activity")
        val audioEditor = (0 until activities.length).map { activities.item(it) }.single { it.attributes.getNamedItemNS(android, "name")?.nodeValue == ".MicrophoneRecordEditorActivity" }
        assertEquals("false", audioEditor.attributes.getNamedItemNS(android, "exported").nodeValue)
    }

    @Test fun `focus interruption stays paused until an explicit successful resume`() {
        val machine = RecordingStateMachine()
        machine.prepare(); machine.started(true)
        assertEquals(RecordingPhase.RECORDING, machine.phase)
        machine.pause(true)
        assertEquals(RecordingPhase.PAUSED, machine.phase); assertTrue(machine.interrupted)
        // A repeated loss and focus recovery do not start capture.
        machine.pause(true); machine.started(true)
        assertEquals(RecordingPhase.PAUSED, machine.phase)
        machine.resume(false)
        assertEquals(RecordingPhase.PAUSED, machine.phase); assertTrue(machine.interrupted)
        machine.resume(true)
        assertEquals(RecordingPhase.RECORDING, machine.phase); assertFalse(machine.interrupted)
        machine.stop(); machine.resume(true)
        assertEquals(RecordingPhase.STOPPING, machine.phase)
        machine.finished(); assertEquals(RecordingPhase.IDLE, machine.phase)
    }

    @Test fun `denied initial focus and manual pause never start without consent`() {
        val machine = RecordingStateMachine()
        machine.prepare(); machine.started(false)
        assertEquals(RecordingPhase.PAUSED, machine.phase); assertTrue(machine.interrupted)
        machine.resume(true); machine.pause(false)
        assertEquals(RecordingPhase.PAUSED, machine.phase); assertFalse(machine.interrupted)
        machine.stop(); machine.finished(); machine.prepare(); machine.pause(true); machine.started(true)
        assertEquals(RecordingPhase.PAUSED, machine.phase)
    }
}
