package dev.mote.collector

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import dev.mote.collector.plugins.NativeAdministrationPlugin

/** The scan Activity only hosts the camera view; the administration plugin
 * owns the mixed-polarity decoder policy. */
internal fun connectionScanDecoderFactory() = NativeAdministrationPlugin.scanDecoderFactory()

/** Camera frames are decoded locally in memory; no image capture/storage or external scanner app. */
class ConnectionScanActivity : MoteActivity() {
    private lateinit var scanner: DecoratedBarcodeView
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val body = moteDetailPage(primary = null, title = MoteI18n.text("扫描连接二维码"))
        body.addView(TextView(this).apply { text = MoteI18n.text("扫描中央生成的连接二维码\n仅用于本次扫码；画面不保存、不上传。返回可用粘贴或 JSON 文件连接。"); MoteUi.type(this, NativeFontRole.SUPPORT); MoteUi.textColor(this, NativeColorRole.MUTED); setPadding(0, 0, 0, moteDp(MoteTheme.spaceItem)) })
        scanner = DecoratedBarcodeView(this).apply { setStatusText(MoteI18n.text("将二维码放入取景框")); barcodeView.decoderFactory = connectionScanDecoderFactory() }
        body.addView(scanner, LinearLayout.LayoutParams(-1, 0, 1f))
        scanner.decodeSingle(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult) {
                scanner.pause()
                if (result.text.length <= ConnectionInvitation.MAX_BYTES * 2) setResult(RESULT_OK, Intent().putExtra("invitation", result.text))
                finish()
            }
        })
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
    }
    override fun onResume() { super.onResume(); if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanner.resume() }
    override fun onPause() { scanner.pause(); super.onPause() }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 1 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) scanner.resume() else finish()
    }
}
