package com.everydayfuel.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONObject

/**
 * Native ML Kit vision plugin (spec §7): label OCR and barcode decoding.
 *
 * The web layer acquires the image (camera capture or file picker) and hands it
 * over as a content URI (`imagePath`) or a base64 string (`imageBase64`).
 * ML Kit runs fully on-device (bundled models — barcode-scanning and
 * text-recognition v2 Latin, no Google Play services dependency, offline).
 *
 * Raw OCR text is returned to the web layer where Gemma/the deterministic
 * parser structures it into nutrition data. Barcodes are identifiers only:
 * nutrition data always comes from the local product record or the scanned
 * label — never guessed (spec §7.4).
 */
@CapacitorPlugin(name = "VisionPlugin")
class VisionPlugin : Plugin() {

    private val maxDimension = 1280

    private fun loadBitmap(call: PluginCall): Bitmap? {
        val path = call.getString("imagePath")
        val base64 = call.getString("imageBase64")

        val bitmap = when {
            !path.isNullOrEmpty() -> {
                try {
                    context.contentResolver.openInputStream(Uri.parse(path))
                        ?.use { BitmapFactory.decodeStream(it) }
                } catch (e: Exception) {
                    null
                }
            }
            !base64.isNullOrEmpty() -> {
                try {
                    val cleaned = base64.substringAfter(',')
                    val bytes = Base64.decode(cleaned, Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                } catch (e: Exception) {
                    null
                }
            }
            else -> null
        }

        return bitmap?.let { downscale(it) }
    }

    /** Downscale so ML Kit sees a bounded bitmap (faster, more accurate). */
    private fun downscale(src: Bitmap): Bitmap {
        val max = maxOf(src.width, src.height)
        if (max <= maxDimension) return src
        val scale = maxDimension.toFloat() / max
        val w = (src.width * scale).toInt().coerceAtLeast(1)
        val h = (src.height * scale).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(src, w, h, true)
    }

    @PluginMethod
    fun scanBarcode(call: PluginCall) {
        val bitmap = loadBitmap(call)
        if (bitmap == null) {
            call.reject("No decodable image provided (imagePath or imageBase64)")
            return
        }

        val image = InputImage.fromBitmap(bitmap, 0)
        BarcodeScanning.getClient().process(image)
            .addOnSuccessListener { barcodes ->
                val barcode = barcodes.firstOrNull { !it.rawValue.isNullOrEmpty() }
                val ret = JSObject()
                ret.put("barcode", barcode?.rawValue ?: JSONObject.NULL)
                ret.put("format", barcode?.format ?: JSONObject.NULL)
                call.resolve(ret)
            }
            .addOnFailureListener { e ->
                call.reject("Barcode scanning failed: ${e.message}", e)
            }
    }

    @PluginMethod
    fun ocrLabel(call: PluginCall) {
        val bitmap = loadBitmap(call)
        if (bitmap == null) {
            call.reject("No decodable image provided (imagePath or imageBase64)")
            return
        }

        val image = InputImage.fromBitmap(bitmap, 0)
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).process(image)
            .addOnSuccessListener { visionText ->
                val ret = JSObject()
                ret.put("text", visionText.text)
                call.resolve(ret)
            }
            .addOnFailureListener { e ->
                call.reject("Text recognition failed: ${e.message}", e)
            }
    }
}