package com.everydayfuel.app

import android.content.ContentValues
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * Saves exports/backups into the public Downloads folder via MediaStore
 * (Android 10+, no storage permission required for app-created files).
 * The Android WebView silently drops blob-anchor downloads, so the web layer
 * routes CSV/JSON saves through this plugin when running natively.
 */
@CapacitorPlugin(name = "SaveFilePlugin")
class SaveFilePlugin : Plugin() {

    @PluginMethod
    fun saveDownload(call: PluginCall) {
        val fileName = call.getString("fileName") ?: ""
        val base64Data = call.getString("base64") ?: ""
        val mime = call.getString("mime") ?: "application/octet-stream"

        if (fileName.isBlank() || base64Data.isBlank()) {
            call.reject("fileName and base64 are required")
            return
        }

        try {
            val bytes = Base64.decode(base64Data, Base64.DEFAULT)
            val resolver = context.contentResolver

            // Reuse an existing Downloads entry with the same name so repeat
            // exports overwrite instead of piling up " (1)" copies.
            var existingId: Long? = null
            val cursor = resolver.query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.MediaColumns._ID),
                "${MediaStore.MediaColumns.DISPLAY_NAME} = ?",
                arrayOf(fileName),
                null
            )
            if (cursor != null) {
                cursor.use { c ->
                    if (c.moveToFirst()) existingId = c.getLong(0)
                }
                cursor.close()
            }

            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                if (existingId == null) {
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
            }

            val uri = if (existingId != null) {
                android.content.ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, existingId!!)
            } else {
                resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("MediaStore insert returned null")
            }

            resolver.openOutputStream(uri, "w")?.use { os ->
                os.write(bytes)
                os.flush()
            } ?: throw IllegalStateException("Could not open output stream")

            if (existingId == null) {
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            }

            val result = JSObject()
            result.put("saved", true)
            result.put("uri", uri.toString())
            call.resolve(result)
        } catch (e: Exception) {
            call.reject("Save failed: ${e.message}", e)
        }
    }
}
