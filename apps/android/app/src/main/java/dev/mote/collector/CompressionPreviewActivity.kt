package dev.mote.collector

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.*
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/** Uses the capture pipeline's Bitmap resize/JPEG codec on generated content only. */
class CompressionPreviewActivity : MoteActivity() {
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var revision = 0
    private var quality = 75
    private var maxSide = 1280
    private var images: List<Bitmap> = emptyList()
    private var dialog: AlertDialog? = null
    private lateinit var stats: TextView
    private lateinit var originalView: ImageView
    private lateinit var compressedView: ImageView
    private lateinit var apply: Button
    override fun onCreate(state: Bundle?) {
        super.onCreate(state); window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val config = Settings(this).read()
        quality = state?.getInt("quality") ?: config.jpegQuality; maxSide = state?.getInt("maxSide") ?: config.captureMaxSide
        val body = moteDetailPage()
        fun text(value: String, size: Float = 14f) = TextView(this).apply { text = value; textSize = size; setPadding(0, moteDp(8), 0, moteDp(8)); body.addView(this) }
        text(MoteI18n.text("图片压缩预览"), 27f)
        text(MoteI18n.text("用生成的图文样张比较小字、渐变和细线。只在内存处理，不读取或上传屏幕。"))
        val label = text(MoteI18n.text("JPEG 质量 {0} · 不是文件压缩百分比", quality))
        body.addView(SeekBar(this).apply {
            min = 40; max = 95; progress = quality
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: SeekBar?, value: Int, user: Boolean) { quality = value; label.text = MoteI18n.text("JPEG 质量 {0} · 不是文件压缩百分比", value); if (user) { revision++; apply.isEnabled = false } }
                override fun onStartTrackingTouch(bar: SeekBar?) = Unit
                override fun onStopTrackingTouch(bar: SeekBar?) { render() }
            })
        })
        text(MoteI18n.text("图片最长边"))
        val sides = (listOf(640, 960, 1280, 1920, 2560) + maxSide).distinct().sorted()
        val size = Spinner(this).apply { adapter = ArrayAdapter(this@CompressionPreviewActivity, android.R.layout.simple_spinner_dropdown_item, sides.map { "$it px" }); setSelection(sides.indexOf(maxSide)) }; body.addView(size)
        stats = text(MoteI18n.text("正在生成预览…"))
        text(MoteI18n.text("原始示例 · PNG（点击放大）"), 17f)
        originalView = ImageView(this).apply { contentDescription = MoteI18n.text("原始示例"); scaleType = ImageView.ScaleType.FIT_CENTER; body.addView(this, LinearLayout.LayoutParams(-1, moteDp(260))); setOnClickListener { enlarge(0) } }
        text(MoteI18n.text("压缩结果 · JPEG（点击放大）"), 17f)
        compressedView = ImageView(this).apply { contentDescription = MoteI18n.text("压缩结果"); scaleType = ImageView.ScaleType.FIT_CENTER; body.addView(this, LinearLayout.LayoutParams(-1, moteDp(260))); setOnClickListener { enlarge(1) } }
        text(MoteI18n.text("放大后可双指缩放、拖动检查小字；双击复位。文件大小与缩放比例依据本次编码实测。"))
        apply = Button(this).apply { text = MoteI18n.text("将参数带回采集设置"); isEnabled = false; setOnClickListener { setResult(RESULT_OK, Intent().putExtra("quality", quality).putExtra("maxSide", maxSide)); finish() } }; body.addView(apply)
        text(MoteI18n.text("返回采集设置后点击保存，才会应用到后续采集。"))
        size.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) { if (maxSide != sides[position]) { maxSide = sides[position]; render() } }
        }
        MoteUi.styleTree(body); render()
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
        val stamp = ++revision; val q = quality; val side = maxSide
        apply.isEnabled = false; stats.text = MoteI18n.text("正在生成压缩预览…"); dialog?.dismiss()
        executor.execute {
            if (stamp != revision) return@execute
            var source: Bitmap? = null; var resized: Bitmap? = null; var decoded: Bitmap? = null
            try {
                val original = fixture(); source = original
                val png = encode(original, Bitmap.CompressFormat.PNG, 100)
                val scale = minOf(1f, side.toFloat() / maxOf(original.width, original.height))
                val output = Bitmap.createScaledBitmap(original, (original.width * scale).roundToInt(), (original.height * scale).roundToInt(), true); resized = output
                val jpeg = encode(output, Bitmap.CompressFormat.JPEG, q)
                val result = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: error(MoteI18n.text("无法解码 JPEG")); decoded = result
                val message = MoteI18n.text("1440 × 2560 → {0} × {1}\n边长缩放 {2}% · PNG {3} KB → JPEG {4} KB\n文件大小为原图的 {5}%", output.width, output.height, "%.1f".format(scale * 100), png.size / 1024, jpeg.size / 1024, "%.1f".format(jpeg.size * 100.0 / png.size))
                if (output !== original) output.recycle()
                runOnUiThread {
                    if (isDestroyed || stamp != revision) { original.recycle(); result.recycle(); return@runOnUiThread }
                    originalView.setImageBitmap(original); compressedView.setImageBitmap(result)
                    images.forEach(Bitmap::recycle); images = listOf(original, result); stats.text = message; apply.isEnabled = true
                }
            } catch (_: Exception) {
                listOfNotNull(source, resized, decoded).distinct().forEach { if (!it.isRecycled) it.recycle() }
                runOnUiThread { if (!isDestroyed && stamp == revision) stats.text = MoteI18n.text("预览未完成，请调整参数重试。") }
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
    override fun onSaveInstanceState(outState: Bundle) { outState.putInt("quality", quality); outState.putInt("maxSide", maxSide); super.onSaveInstanceState(outState) }
    override fun onDestroy() { revision++; dialog?.dismiss(); executor.shutdownNow(); originalView.setImageDrawable(null); compressedView.setImageDrawable(null); images.forEach(Bitmap::recycle); images = emptyList(); super.onDestroy() }
}
