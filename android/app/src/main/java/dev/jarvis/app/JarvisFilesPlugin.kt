package dev.jarvis.app

import android.content.Intent
import android.Manifest
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.*
import java.io.File

@CapacitorPlugin(name = "JarvisFiles", permissions = [Permission(alias = "storage", strings = [Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE])])
class JarvisFilesPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val shared get() = Environment.getExternalStorageDirectory().canonicalFile
    private val inbox get() = File(context.filesDir, "inbox").apply { mkdirs() }
    private val memory get() = File(context.filesDir, "memory.md")
    private var traceFile: File? = null

    @PluginMethod fun appendTrace(call: PluginCall) {
        scope.launch {
            try {
                val line = call.getString("line") ?: error("Missing trace line")
                val bytes = line.toByteArray(Charsets.UTF_8)
                val maxBytes = (call.getInt("maxBytes") ?: 10485760).coerceIn(1024, 10485760)
                val maxFiles = (call.getInt("maxFiles") ?: 10).coerceIn(1, 10)
                require(bytes.size <= 4 * 1024 * 1024 && line.endsWith("\n")) { "Invalid trace line" }
                val path = synchronized(this@JarvisFilesPlugin) {
                    val dir = File(context.filesDir, "traces").apply { mkdirs() }
                    if (traceFile == null || traceFile!!.length() + bytes.size > maxBytes) {
                        dir.listFiles().orEmpty().filter { it.name.startsWith("jarvis-trace-") && it.extension == "jsonl" }
                            .sortedByDescending { it.lastModified() }.drop(maxFiles - 1).forEach { it.delete() }
                        traceFile = File(dir, "jarvis-trace-${System.currentTimeMillis()}-${java.util.UUID.randomUUID()}.jsonl")
                    }
                    traceFile!!.appendBytes(bytes)
                    traceFile!!.path
                }
                call.resolve(JSObject().put("path", path))
            } catch (e: Exception) { call.reject(e.message ?: "Trace write failed", e) }
        }
    }

    private fun vet(raw: String): File {
        require(raw.isNotBlank()) { "Missing path" }
        val path = if (raw.startsWith("~/")) shared.path + raw.substring(1) else raw
        val target = File(path).let { if (it.isAbsolute) it else File(shared, path) }.canonicalFile
        val roots = listOf(shared, inbox.canonicalFile)
        require(roots.any { target == it || target.path.startsWith(it.path + File.separator) }) { "Path outside shared storage" }
        val parts = target.path.lowercase().split(File.separatorChar)
        require(parts.none { it in setOf(".ssh", ".aws", ".claude", ".codex", ".gnupg", ".azure", ".kube", ".docker") || it == ".env" || it.startsWith(".env.") }) { "Credential location refused" }
        require(!Regex("(?i)^(\\.env(\\..*)?|\\.netrc|\\.git-credentials|\\.npmrc|\\.pypirc|\\.claude\\.json|id_[a-z0-9]+|.*\\.(pem|key|p12|pfx|jks|keystore|kdbx))$").matches(target.name)) { "Credential file refused" }
        require(!target.invariantSeparatorsPath.contains("/.config/gh/", true) && !target.invariantSeparatorsPath.contains("/.config/gcloud/", true)) { "Credential location refused" }
        val rel = target.relativeToOrNull(shared)?.invariantSeparatorsPath?.lowercase() ?: ""
        require(rel != "android" && !rel.startsWith("android/data") && !rel.startsWith("android/obb")) { "Android private storage refused" }
        return target
    }

    @PluginMethod fun status(call: PluginCall) {
        call.resolve(JSObject().put("granted", if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager() else getPermissionState("storage") == PermissionState.GRANTED)
            .put("root", shared.path).put("inbox", inbox.path))
    }

    @PluginMethod fun requestAccess(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 30 && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storageResult"); return
        }
        if (Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()) {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                Uri.parse("package:${context.packageName}")))
        }
        call.resolve()
    }

    @PermissionCallback private fun storageResult(call: PluginCall) { status(call) }

    @PluginMethod fun run(call: PluginCall) {
        scope.launch {
            try {
                val args = call.getObject("args") ?: JSObject()
                val name = call.getString("name") ?: ""
                android.util.Log.i("JarvisFiles", "Running $name on Android")
                // Primitives only: filtering, paging and wording belong to the tool
                // catalogue shared with the PC (shared/tools.mjs).
                val result: String = when (name) {
                    "list_files" -> {
                        val folder = vet(args.optString("folder", shared.path))
                        require(folder.isDirectory) { "Folder unavailable; check storage permission" }
                        val entries = org.json.JSONArray()
                        folder.listFiles().orEmpty().filter { runCatching { vet(it.path) }.isSuccess }.forEach {
                            entries.put(org.json.JSONObject().put("name", it.name).put("dir", it.isDirectory).put("size", it.length()))
                        }
                        entries.toString()
                    }
                    "read_file" -> {
                        val file = vet(args.optString("path"))
                        require(file.isFile && file.length() <= 4 * 1024 * 1024) { "Not a text file or file too large" }
                        val bytes = file.readBytes()
                        require(!bytes.take(4096).contains(0.toByte())) { "Binary file cannot be read as text" }
                        val text = bytes.toString(Charsets.UTF_8)
                        val from = args.optInt("from", 0).coerceIn(0, text.length)
                        val end = (from + args.optInt("length", 1600).coerceIn(1, 8000)).coerceAtMost(text.length)
                        org.json.JSONObject().put("text", text.substring(from, end)).put("total", text.length).toString()
                    }
                    "write_file" -> {
                        val target = vet(args.optString("path"))
                        val content = args.optString("content")
                        require(content.length <= 1024 * 1024) { "Text too large" }
                        target.parentFile?.mkdirs(); target.writeText(content); "Written."
                    }
                    "move_file" -> {
                        val from = vet(args.optString("from")); val to = vet(args.optString("to"))
                        require(from.isFile) { "Only individual files can be moved" }
                        require(!to.exists()) { "Destination already exists" }
                        to.parentFile?.mkdirs()
                        // Shared storage is often a separate filesystem from the private inbox.
                        java.nio.file.Files.move(from.toPath(), to.toPath())
                        "Moved."
                    }
                    "open" -> {
                        val asked = args.optString("target").trim()
                        val view = if (asked.startsWith("https://", true) || asked.startsWith("http://", true)) {
                            Intent(Intent.ACTION_VIEW, Uri.parse(asked))
                        } else {
                            val target = vet(asked)
                            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", target)
                            val type = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(target.extension.lowercase()) ?: "*/*"
                            Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        withContext(Dispatchers.Main) { activity.startActivity(view) }; "Opened."
                    }
                    else -> error("Unknown tool")
                }
                call.resolve(JSObject().put("result", result))
            } catch (e: Exception) { call.reject(e.message ?: "File operation failed", e) }
        }
    }

    // The memory file, whole: its format, limits and matching are the shared
    // rules (shared/memory.mjs), applied in the WebView as on the PC.
    @PluginMethod fun readMemory(call: PluginCall) {
        val text = synchronized(this) { if (memory.exists()) memory.readText() else "" }
        call.resolve(JSObject().put("text", text))
    }

    @PluginMethod fun writeMemory(call: PluginCall) {
        val text = call.getString("text") ?: return call.reject("Missing text")
        try {
            synchronized(this) { memory.writeText(text) }
            call.resolve()
        } catch (e: Exception) { call.reject(e.message ?: "Memory write failed", e) }
    }

    @PluginMethod fun saveAttachment(call: PluginCall) {
        scope.launch {
            try {
                val bytes = android.util.Base64.decode(call.getString("data"), android.util.Base64.DEFAULT)
                require(bytes.size <= 16 * 1024 * 1024) { "Attachment too large; use Android share for larger files" }
                val name = File(call.getString("name") ?: "file").name.replace(Regex("[^\\p{L}\\p{N}._-]"), "_").take(120)
                val file = File(inbox, "${java.util.UUID.randomUUID()}-$name")
                file.writeBytes(bytes)
                call.resolve(JSObject().put("path", file.path).put("name", name).put("size", bytes.size))
            } catch (e: Exception) { call.reject(e.message ?: "Could not save attachment", e) }
        }
    }

    @PluginMethod fun takeShares(call: PluginCall) {
        call.resolve(JSObject().put("files", MainActivity.takeShares()))
    }

    @PluginMethod fun upload(call: PluginCall) {
        scope.launch {
            var connection: java.net.HttpURLConnection? = null
            try {
                val file = vet(call.getString("path") ?: "")
                require(file.isFile && file.length() <= 1024L * 1024 * 1024) { "File too large" }
                val base = java.net.URI(call.getString("url") ?: "")
                require(base.scheme == "https" && base.host.endsWith(".ts.net") && base.port == -1 && base.rawUserInfo == null) { "Expected a Tailscale HTTPS address" }
                val url = java.net.URL("${base.scheme}://${base.host}/upload?name=${java.net.URLEncoder.encode(file.name, "UTF-8")}")
                connection = url.openConnection() as java.net.HttpURLConnection
                val conn = connection
                conn.instanceFollowRedirects = false
                conn.requestMethod = "POST"; conn.doOutput = true
                conn.connectTimeout = 15_000; conn.readTimeout = 120_000
                conn.setFixedLengthStreamingMode(file.length())
                conn.setRequestProperty("Content-Type", "application/octet-stream")
                conn.setRequestProperty("Origin", "https://jarvis.app")
                val token = call.getString("token") ?: ""
                if (token.isNotBlank()) conn.setRequestProperty("Authorization", "Bearer $token")
                conn.outputStream.use { output -> file.inputStream().use { it.copyTo(output, 128 * 1024) } }
                require(conn.responseCode == 200) { "PC upload refused (${conn.responseCode})" }
                val json = conn.inputStream.bufferedReader().use { it.readText().take(8192) }
                call.resolve(JSObject(json))
            } catch (e: Exception) { call.reject(e.message ?: "Upload failed", e) }
            finally { connection?.disconnect() }
        }
    }
    override fun handleOnDestroy() { scope.cancel() }
}
