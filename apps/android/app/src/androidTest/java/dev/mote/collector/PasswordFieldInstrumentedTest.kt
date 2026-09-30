package dev.mote.collector

import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Generated in-memory fields only. Does not read, save, replace or transmit any real credential. */
@RunWith(AndroidJUnit4::class)
class PasswordFieldInstrumentedTest {
    @Test fun savedAndEditedGeneratedCredentialRemainMaskedAndMarkedAsPassword() {
        ActivityScenario.launch(FixtureActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                val field = MoteUi.field(EditText(activity))
                MoteUi.textInput(field, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
                field.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
                field.isSaveEnabled = false
                activity.setContentView(LinearLayout(activity).apply { addView(field) })
                for (generated in listOf("generated-fixture-" + "x".repeat(46), "replacement-fixture-" + "y".repeat(44))) {
                    field.setText(generated)
                    // Reapplying shared visual styling must not remove credential semantics.
                    MoteUi.styleTree(field)
                    assertTrue("Editable value is preserved", field.text.toString() == generated)
                    assertTrue("Password transformation is retained", field.transformationMethod is PasswordTransformationMethod)
                    assertTrue("Visible text is masked", field.transformationMethod.getTransformation(field.text, field).toString() != generated)
                    val node = field.createAccessibilityNodeInfo()
                    assertTrue("Accessibility identifies a password field", node.isPassword)
                    assertTrue("No plaintext credential in default accessibility text", node.text?.toString() != generated)
                }
                assertTrue("Secure window remains enabled", activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
            }
        }
    }

    @Test fun normalUriAndMultilineTextRetainTheirInputBehavior() {
        ActivityScenario.launch(FixtureActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val address = MoteUi.textInput(MoteUi.field(EditText(activity)), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
                address.setText("https://generated.fixture.invalid")
                assertEquals(InputType.TYPE_TEXT_VARIATION_URI, address.inputType and InputType.TYPE_MASK_VARIATION)
                assertFalse(address.createAccessibilityNodeInfo().isPassword)
                val note = MoteUi.textInput(MoteUi.field(EditText(activity)), InputType.TYPE_CLASS_TEXT, multiline = true)
                note.setText("Generated first line\nGenerated second line")
                assertTrue(note.inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0)
                assertFalse(note.createAccessibilityNodeInfo().isPassword)
                assertTrue(note.text.toString().contains('\n'))
            }
        }
    }
}
