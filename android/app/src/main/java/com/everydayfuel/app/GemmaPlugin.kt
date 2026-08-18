package com.everydayfuel.app

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.JSObject
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import java.io.File

@CapacitorPlugin(name = "GemmaPlugin")
class GemmaPlugin : Plugin() {

    private var llmInference: LlmInference? = null
    private var isInitialized = false

    @PluginMethod
    fun initializeModel(call: PluginCall) {
        val modelPath = call.getString("modelPath")
        if (modelPath.isNullOrEmpty()) {
            call.reject("Model path must be specified")
            return
        }

        val file = File(modelPath)
        if (!file.exists()) {
            call.reject("Model file not found at path: $modelPath")
            return
        }

        try {
            val options = LlmInference.LlmInferenceOptions.builder()
                .setModelPath(modelPath)
                .setMaxTokens(512)
                .setResultListener { partialResult, done ->
                    // Stream listener if needed
                }
                .build()

            llmInference = LlmInference.createFromOptions(context, options)
            isInitialized = true
            
            val ret = JSObject()
            ret.put("status", "success")
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("Failed to initialize Gemma model: ${e.message}", e)
        }
    }

    @PluginMethod
    fun generateResponse(call: PluginCall) {
        val prompt = call.getString("prompt")
        if (prompt.isNullOrEmpty()) {
            call.reject("Prompt cannot be empty")
            return
        }

        if (!isInitialized || llmInference == null) {
            call.reject("Gemma model is not initialized")
            return
        }

        try {
            val response = llmInference?.generateResponse(prompt)
            val ret = JSObject()
            ret.put("value", response ?: "")
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("Inference failed: ${e.message}", e)
        }
    }
}
