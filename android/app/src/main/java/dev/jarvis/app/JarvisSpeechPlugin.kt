package dev.jarvis.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.*
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.getcapacitor.*
import com.getcapacitor.annotation.*
import java.util.Locale

@CapacitorPlugin(name = "JarvisSpeech", permissions = [Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])])
class JarvisSpeechPlugin : Plugin(), RecognitionListener {
    private var recognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private var ready = false
    private var active = false
    private val spoken = mutableMapOf<String, PluginCall>()

    override fun load() {
        activity.runOnUiThread {
            tts = TextToSpeech(context) { code -> ready = code == TextToSpeech.SUCCESS }
            tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(id: String?) {}
                override fun onDone(id: String?) { finish(id, true) }
                @Deprecated("Android callback")
                override fun onError(id: String?) { finish(id, false) }
                override fun onStop(id: String?, interrupted: Boolean) { finish(id, false) }
            })
        }
    }

    private fun finish(id: String?, ok: Boolean) {
        activity.runOnUiThread { spoken.remove(id)?.resolve(JSObject().put("completed", ok)) }
    }

    @PluginMethod fun start(call: PluginCall) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "permissionResult"); return
        }
        listen(call)
    }

    @PermissionCallback private fun permissionResult(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) listen(call)
        else call.reject("Microphone access denied")
    }

    private fun listen(call: PluginCall) {
        activity.runOnUiThread {
            try {
                if (active) { call.resolve(); return@runOnUiThread }
                require(SpeechRecognizer.isRecognitionAvailable(context)) { "No speech recognition service installed" }
                if (recognizer == null) recognizer = if (Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context))
                    SpeechRecognizer.createOnDeviceSpeechRecognizer(context) else SpeechRecognizer.createSpeechRecognizer(context)
                recognizer!!.setRecognitionListener(this)
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE, call.getString("lang") ?: "fr-FR")
                    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                active = true
                recognizer!!.startListening(intent)
                call.resolve()
            } catch (e: Exception) { active = false; call.reject(e.message ?: "Recognition failed", e) }
        }
    }

    @PluginMethod fun stop(call: PluginCall) {
        activity.runOnUiThread { active = false; recognizer?.cancel(); call.resolve() }
    }

    @PluginMethod fun speak(call: PluginCall) {
        activity.runOnUiThread {
            if (!ready) { call.reject("Android voice is not ready; check installed TTS engine"); return@runOnUiThread }
            val language = tts!!.setLanguage(Locale.forLanguageTag(call.getString("lang") ?: "fr-FR"))
            if (language < 0) { call.reject("Install the requested Android voice in system settings"); return@runOnUiThread }
            val id = java.util.UUID.randomUUID().toString()
            spoken[id] = call
            tts!!.setSpeechRate(0.95f)
            if (tts!!.speak(call.getString("text") ?: "", TextToSpeech.QUEUE_ADD, null, id) == TextToSpeech.ERROR)
                finish(id, false)
        }
    }

    @PluginMethod fun stopSpeaking(call: PluginCall) {
        activity.runOnUiThread {
            tts?.stop()
            spoken.values.toList().forEach { it.resolve(JSObject().put("completed", false)) }
            spoken.clear(); call.resolve()
        }
    }

    private fun transcript(bundle: Bundle?, final: Boolean) {
        val text = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
        if (final) active = false
        notifyListeners("recognition", JSObject().put("text", text).put("final", final))
    }
    override fun onResults(results: Bundle?) = transcript(results, true)
    override fun onPartialResults(results: Bundle?) = transcript(results, false)
    override fun onError(error: Int) {
        active = false
        notifyListeners("recognition", JSObject().put("error", error).put("final", true))
    }
    override fun onReadyForSpeech(params: Bundle?) {}
    override fun onBeginningOfSpeech() { notifyListeners("speechStart", JSObject()) }
    override fun onEndOfSpeech() {}
    override fun onRmsChanged(rmsdB: Float) {}
    override fun onBufferReceived(buffer: ByteArray?) {}
    override fun onEvent(eventType: Int, params: Bundle?) {}

    override fun handleOnPause() { activity.runOnUiThread { active = false; recognizer?.cancel(); tts?.stop() } }
    override fun handleOnDestroy() {
        activity.runOnUiThread {
            recognizer?.destroy(); tts?.shutdown()
            spoken.values.toList().forEach { it.resolve(JSObject().put("completed", false)) }; spoken.clear()
        }
    }
}
