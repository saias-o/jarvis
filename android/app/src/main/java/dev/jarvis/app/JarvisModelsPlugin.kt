package dev.jarvis.app

import android.app.Activity
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.getcapacitor.*
import com.getcapacitor.annotation.*
import androidx.activity.result.ActivityResult
import kotlinx.coroutines.*
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

@CapacitorPlugin(name = "JarvisModels")
class JarvisModelsPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val downloading = AtomicBoolean(false)
    @Volatile private var cancelled = false
    private val dir get() = File(context.filesDir, "models").apply { mkdirs() }
    private val model get() = File(dir, "gemma.litertlm")

    @PluginMethod fun status(call: PluginCall) {
        call.resolve(JSObject().put("path", if (model.isFile) model.path else "")
            .put("size", model.length()).put("downloading", downloading.get()))
    }

    @PluginMethod fun cancel(call: PluginCall) { cancelled = true; call.resolve() }

    private fun wifi(): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !cm.isActiveNetworkMetered
    }

    @PluginMethod fun download(call: PluginCall) {
        if (!downloading.compareAndSet(false, true)) { call.reject("Download already running"); return }
        cancelled = false
        scope.launch {
            var connection: HttpURLConnection? = null
            try {
                val wifiOnly = call.getBoolean("wifiOnly", true) != false
                require(!wifiOnly || wifi()) { "Connect to unmetered Wi-Fi or disable Wi-Fi only" }
                val address = call.getString("url") ?: DEFAULT_URL
                require(URL(address).protocol == "https") { "HTTPS is required" }
                val part = File(dir, "model.part")
                val source = File(dir, "model.source")
                val validator = File(dir, "model.etag")
                if (!source.exists() || source.readText() != address) {
                    part.delete(); validator.delete(); source.writeText(address)
                }
                var offset = if (validator.exists()) part.length() else 0L
                require(dir.usableSpace > 3L * 1024 * 1024 * 1024 - offset) { "At least 3 GB free is needed" }
                connection = URL(address).openConnection() as HttpURLConnection
                val conn = connection
                conn.connectTimeout = 30_000; conn.readTimeout = 30_000
                if (offset > 0) {
                    conn.setRequestProperty("Range", "bytes=$offset-")
                    conn.setRequestProperty("If-Range", validator.readText())
                }
                require(conn.responseCode == 200 || conn.responseCode == 206) { "Download refused (${conn.responseCode})" }
                require(conn.url.protocol == "https") { "Insecure redirect refused" }
                if (conn.responseCode == 200) offset = 0
                else require(conn.getHeaderField("Content-Range")?.startsWith("bytes $offset-") == true) { "Invalid resume response" }
                conn.getHeaderField("ETag")?.let { validator.writeText(it) }
                val length = conn.contentLengthLong
                require(length > 0 && length + offset <= 8L * 1024 * 1024 * 1024) { "Invalid model size" }
                val total = offset + length
                var received = offset
                var last = 0L
                RandomAccessFile(part, "rw").use { out ->
                    out.setLength(offset); out.seek(offset)
                    conn.inputStream.use { input ->
                        val buffer = ByteArray(128 * 1024)
                        while (true) {
                            require(!cancelled) { "Download paused; start again to resume" }
                            require(!wifiOnly || wifi()) { "Wi-Fi disconnected; start again to resume" }
                            val n = input.read(buffer)
                            if (n < 0) break
                            received += n
                            require(received <= total) { "Download exceeded expected size" }
                            out.write(buffer, 0, n)
                            val now = System.currentTimeMillis()
                            if (now - last > 300) {
                                notifyListeners("progress", JSObject().put("received", received).put("total", total))
                                last = now
                            }
                        }
                    }
                }
                require(received == total) { "Incomplete download; start again to resume" }
                require(part.renameTo(model)) { "Could not save model" }
                notifyListeners("progress", JSObject().put("received", total).put("total", total))
                call.resolve(JSObject().put("path", model.path))
            } catch (e: Exception) { call.reject(e.message ?: "Download failed", e) }
            finally { connection?.disconnect(); downloading.set(false) }
        }
    }

    @PluginMethod fun importModel(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE)
        startActivityForResult(call, intent, "importResult")
    }

    @ActivityCallback private fun importResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { call.reject("Import cancelled"); return }
        if (!downloading.compareAndSet(false, true)) { call.reject("Download already running"); return }
        scope.launch {
            val part = File(dir, "import.part")
            try {
                context.contentResolver.openInputStream(uri)!!.use { input ->
                    part.outputStream().use { output ->
                        val buffer = ByteArray(128 * 1024)
                        var size = 0L
                        while (true) {
                            val n = input.read(buffer)
                            if (n < 0) break
                            size += n
                            require(size <= 8L * 1024 * 1024 * 1024) { "Model is too large" }
                            output.write(buffer, 0, n)
                        }
                        require(size > 0) { "Empty model" }
                    }
                }
                require(part.renameTo(model)) { "Could not save model" }
                call.resolve(JSObject().put("path", model.path))
            } catch (e: Exception) { part.delete(); call.reject(e.message ?: "Import failed", e) }
            finally { downloading.set(false) }
        }
    }

    override fun handleOnDestroy() { cancelled = true; scope.cancel() }

    companion object {
        const val DEFAULT_URL = "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm"
    }
}
