package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.*
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.text.InputType
import android.view.WindowManager
import android.widget.*
import dev.mote.collector.ui.MoteComponents
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/** Uses the capture pipeline's Bitmap resize/JPEG codec on generated content only. */
class CompressionPreviewActivity : MoteActivity() {
    internal var previewEncoder: (Bitmap,Bitmap.CompressFormat,Int)->ByteArray = ::encode
    private val executor = Executors.newSingleThreadExecutor()
    private val task by lazy { UiTask(this, executor, ownsExecutor = false) }
    @Volatile private var revision = 0
    private var quality = 75
    private var maxSide = 1280
    private var hasParameters = false
    private var images: List<Bitmap> = emptyList()
    private var dialog: AlertDialog? = null
    private lateinit var stats: TextView
    private lateinit var qualityInput: EditText
    private lateinit var originalCaption: TextView
    private lateinit var compressedCaption: TextView
    private lateinit var update: Button
    private lateinit var originalView: ImageView
    private lateinit var compressedView: ImageView
    private lateinit var apply: Button
    override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        quality = state?.getInt("quality") ?: quality; maxSide = state?.getInt("maxSide") ?: maxSide
        hasParameters = state?.containsKey("quality") == true && state.containsKey("maxSide")
        val body = moteDetailPage(title = MoteI18n.text("图片压缩预览"))
        val placeholder = MoteComponents.skeleton(this, MoteI18n.text("正在读取本机设置…")); body.addView(placeholder)
        task.start(MoteI18n.text("正在读取本机设置…"), {}, {
            Settings(applicationContext).read()
        }) { result ->
            result.onSuccess { buildUi(it, state) }.onFailure { failure ->
                body.removeView(placeholder)
                body.addView(TextView(this).apply { text = if (failure.message == MoteI18n.text(LocalDataFormat.RESET_MESSAGE)) failure.message else MoteI18n.text("设置无法读取，原数据保留。请退出后检查存储或重试。") })
            }
        }
    }
    private fun buildUi(config: CollectorConfig, state: Bundle?) {
        quality = state?.getInt("quality") ?: config.jpegQuality; maxSide = state?.getInt("maxSide") ?: config.captureMaxSide
        hasParameters = true
        val body = moteDetailPage(title = MoteI18n.text("图片压缩预览"))
        SecondaryUi.text(body, MoteI18n.text("JPEG 质量"), muted = true)
        qualityInput = EditText(this).apply {
            setSingleLine(); inputType = InputType.TYPE_CLASS_NUMBER
            contentDescription = MoteI18n.text("JPEG 质量")
            setText(state?.getString("qualityDraft") ?: quality.toString())
        }; body.addView(qualityInput)
        SecondaryUi.text(body, MoteI18n.text("输出最长边"), muted = true)
        val sides = (listOf(640, 900, 960, 1280, 1920, 2560) + maxSide).distinct().sorted()
        val size = Spinner(this).apply {
            contentDescription = MoteI18n.text("输出最长边")
            adapter = ArrayAdapter(this@CompressionPreviewActivity, android.R.layout.simple_spinner_dropdown_item, sides.map { "$it px" })
            setSelection(sides.indexOf(maxSide))
        }; body.addView(size)
        update = SecondaryUi.action(SecondaryUi.actions(body), MoteI18n.text("更新预览"), primary = true) { render() }
        val pair = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        body.addView(pair, LinearLayout.LayoutParams(-1, -2).apply { topMargin = moteDp(MoteTheme.spaceItem) })
        fun previewColumn(): LinearLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            pair.addView(this, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = moteDp(MoteTheme.spaceInline) })
        }
        val originalColumn = previewColumn()
        originalView = ImageView(this).apply {
            contentDescription = MoteI18n.text("原始示例"); scaleType = ImageView.ScaleType.FIT_CENTER
            originalColumn.addView(this, LinearLayout.LayoutParams(-1, moteDp(220))); setOnClickListener { enlarge(0) }
        }
        originalCaption = SecondaryUi.text(originalColumn, MoteI18n.text("原图 · PNG"), muted = true)
        val compressedColumn = previewColumn()
        compressedView = ImageView(this).apply {
            contentDescription = MoteI18n.text("压缩结果"); scaleType = ImageView.ScaleType.FIT_CENTER
            compressedColumn.addView(this, LinearLayout.LayoutParams(-1, moteDp(220))); setOnClickListener { enlarge(1) }
        }
        compressedCaption = SecondaryUi.text(compressedColumn, MoteI18n.text("JPEG 输出"), muted = true)
        stats = SecondaryUi.text(body, MoteI18n.text("正在生成预览…"), muted = true)
        SecondaryUi.text(body, MoteI18n.text("点击图片放大，比较文字细节与文件大小。"), muted = true)
        apply = SecondaryUi.action(SecondaryUi.actions(body), MoteI18n.text("将参数带回采集设置")) {
            setResult(RESULT_OK, Intent().putExtra("quality", quality).putExtra("maxSide", maxSide)); finish()
        }.apply { isEnabled = false }
        val details = SecondaryUi.disclosure(body, MoteI18n.text("预览与应用说明"), "compression-details")
        SecondaryUi.text(details, MoteI18n.text("用生成的图文样张比较小字、渐变和细线。只在内存处理，不读取或上传屏幕。"), muted = true)
        SecondaryUi.text(details, MoteI18n.text("放大后可双指缩放、拖动检查小字；双击复位。文件大小与缩放比例依据本次编码实测。"), muted = true)
        SecondaryUi.text(details, MoteI18n.text("返回采集设置后点击保存，才会应用到后续采集。"), muted = true)
        qualityInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { invalidatePreview() }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        size.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) {
                if (maxSide != sides[position]) { maxSide = sides[position]; invalidatePreview() }
            }
        }
        MoteUi.styleTree(body); MoteUi.button(update, true); render()
    }
    private fun invalidatePreview() {
        revision++; apply.isEnabled = false; qualityInput.error = null
        stats.text = MoteI18n.text("参数已改变，点击更新预览。")
        dialog?.dismiss()
    }
    private fun fixture(): Bitmap {
        val image = Bitmap.createBitmap(1440, 2560, Bitmap.Config.ARGB_8888); val canvas = Canvas(image); canvas.drawColor(Color.rgb(246, 243, 235))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(36, 66, 68); textSize = 70f }
        canvas.drawText(MoteI18n.text("Mote · 把细节留在记录里"), 70f, 150f, paint)
        repeat(34) { i -> paint.textSize = (18 + i % 4 * 5).toFloat(); canvas.drawText(MoteI18n.text("{0}  图片清晰度 / Small text Aa 0123456789 → 阅读与记录", i + 1), 75f, 270f + i * 42, paint) }
        paint.shader = LinearGradient(75f, 1800f, 1360f, 2260f, intArrayOf(Color.rgb(73, 126, 147), Color.rgb(231, 181, 120), Color.rgb(137, 105, 142)), null, Shader.TileMode.CLAMP)
        canvas.drawRoundRect(75f, 1770f, 1360f, 2260f, 30f, 30f, paint); paint.shader = null
        repeat(70) { i -> paint.color = Color.WHITE; canvas.drawCircle(100f + i * 97 % 1230, 1800f + i * 61 % 420, (3 + i % 8).toFloat(), paint) }
        paint.color = Color.DKGRAY; paint.textSize = 27f; canvas.drawText(MoteI18n.text("生成示例 · 不读取屏幕 · 不上传"), 75f, 2400f, paint)
        return image
    }
    private fun encode(image: Bitmap, format: Bitmap.CompressFormat, quality: Int) = ByteArrayOutputStream().use { check(image.compress(format, quality, it)); it.toByteArray() }
    private fun render() {
        val requested = qualityInput.text.toString().toIntOrNull()
        if (requested == null || requested !in 40..95) {
            qualityInput.error = MoteI18n.text("质量请输入 40–95。")
            apply.isEnabled = false; return
        }
        quality = requested; qualityInput.error = null
        val stamp = ++revision; val q = quality; val side = maxSide
        apply.isEnabled = false; stats.text = MoteI18n.text("正在生成压缩预览…"); dialog?.dismiss()
        executor.execute {
            if (stamp != revision) return@execute
            var source: Bitmap? = null; var resized: Bitmap? = null; var decoded: Bitmap? = null
            try {
                val original = fixture(); source = original
                val png = previewEncoder(original, Bitmap.CompressFormat.PNG, 100)
                val scale = minOf(1f, side.toFloat() / maxOf(original.width, original.height))
                val output = Bitmap.createScaledBitmap(original, (original.width * scale).roundToInt(), (original.height * scale).roundToInt(), true); resized = output
                val jpeg = previewEncoder(output, Bitmap.CompressFormat.JPEG, q)
                val result = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: error(MoteI18n.text("无法解码 JPEG")); decoded = result
                val message = MoteI18n.text("1440 × 2560 → {0} × {1}\n边长缩放 {2}% · PNG {3} KB → JPEG {4} KB\n文件大小为原图的 {5}%", output.width, output.height, "%.1f".format(scale * 100), png.size / 1024, jpeg.size / 1024, "%.1f".format(jpeg.size * 100.0 / png.size))
                if (output !== original) output.recycle()
                runOnUiThread {
                    if (isDestroyed || stamp != revision) { original.recycle(); result.recycle(); return@runOnUiThread }
                    originalView.setImageBitmap(original); compressedView.setImageBitmap(result)
                    images.forEach(Bitmap::recycle); images = listOf(original, result); stats.text = message; apply.isEnabled = true
                    originalCaption.text = MoteI18n.text("原图 · {0} × {1} · {2} B", original.width, original.height, png.size)
                    compressedCaption.text = MoteI18n.text("JPEG · {0} × {1} · {2} B", result.width, result.height, jpeg.size)
                }
            } catch (_: Exception) {
                listOfNotNull(source, resized, decoded).distinct().forEach { if (!it.isRecycled) it.recycle() }
                runOnUiThread { if (!isDestroyed && stamp == revision) {
                    originalView.setImageDrawable(null);compressedView.setImageDrawable(null);images.forEach { if(!it.isRecycled)it.recycle() };images=emptyList()
                    originalCaption.text=MoteI18n.text("原图 · PNG");compressedCaption.text=MoteI18n.text("JPEG 输出")
                    stats.text = MoteI18n.text("预览未完成，请调整参数重试。")
                } }
            }
        }
    }
    private fun enlarge(index: Int) {
        if (images.size < 2) return
        val image = BulkDedupeImageView(this).apply { setImageBitmap(images[index]); contentDescription = MoteI18n.text("双指缩放、拖动，双击复位") }
        dialog = MoteDialogBuilder(this).setTitle(if (index == 0) MoteI18n.text("原始示例 · 双指放大") else MoteI18n.text("压缩结果 · 双指放大"))
            .setView(image).setPositiveButton(MoteI18n.text("关闭"), null).setNeutralButton(if (index == 0) MoteI18n.text("看压缩结果") else MoteI18n.text("看原图")) { _, _ -> enlarge(1 - index) }.create()
        dialog!!.show(); dialog!!.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        image.layoutParams = image.layoutParams.apply { height = (resources.displayMetrics.heightPixels * .65).toInt() }
    }
    override fun onSaveInstanceState(outState: Bundle) { if (hasParameters) { outState.putInt("quality", quality); outState.putInt("maxSide", maxSide); if (::qualityInput.isInitialized) outState.putString("qualityDraft", qualityInput.text.toString()) }; super.onSaveInstanceState(outState) }
    override fun onDestroy() { revision++; dialog?.dismiss(); executor.shutdownNow(); if (::originalView.isInitialized) originalView.setImageDrawable(null); if (::compressedView.isInitialized) compressedView.setImageDrawable(null); images.forEach(Bitmap::recycle); images = emptyList(); super.onDestroy() }
}
