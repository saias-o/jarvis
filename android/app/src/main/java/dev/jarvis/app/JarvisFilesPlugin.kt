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
                val result: String = when (name) {
                    "list_files" -> {
                        val folder = vet(args.optString("folder", shared.path))
                        require(folder.isDirectory) { "Folder unavailable; check storage permission" }
                        val documents = setOf("pdf", "doc", "docx", "odt", "ods", "xls", "xlsx", "ppt", "pptx", "txt", "md", "rtf", "csv", "json", "xml", "html", "htm", "epub")
                        val kind = args.optString("kind", "all")
                        require(kind in setOf("all", "documents")) { "Unknown file kind" }
                        val files = folder.listFiles().orEmpty().filter { it.name.contains(args.optString("contains"), true) }
                            .filter { kind != "documents" || (it.isFile && it.extension.lowercase() in documents) }
                            .filter { runCatching { vet(it.path) }.isSuccess }.sortedBy { it.name.lowercase() }
                        val start = args.optInt("from", 0).coerceIn(0, files.size)
                        val page = StringBuilder()
                        var shown = 0
                        for (file in files.drop(start).take(40)) {
                            val line = file.name + if (file.isDirectory) "/" else " (${file.length()} bytes)"
                            if (shown > 0 && page.length + line.length > 1600) break
                            page.append(line).append('\n'); shown++
                        }
                        val next = start + shown
                        if (next < files.size) page.append("[${files.size - next} more entries; continue with from=$next]")
                        else page.append("[End of folder: ${files.size} entries total]")
                        page.toString()
                    }
                    "read_file" -> {
                        val file = vet(args.optString("path"))
                        require(file.isFile && file.length() <= 4 * 1024 * 1024) { "Not a text file or file too large" }
                        val bytes = file.readBytes()
                        require(!bytes.take(4096).contains(0.toByte())) { "Binary file cannot be read as text" }
                        val text = bytes.toString(Charsets.UTF_8)
                        val from = args.optInt("from", 0).coerceIn(0, text.length)
                        val end = (from + 1800).coerceAtMost(text.length)
                        text.substring(from, end) + if (end < text.length) "\n[Read on with from=$end]" else ""
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
                        val target = vet(args.optString("target"))
                        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", target)
                        val type = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(target.extension.lowercase()) ?: "*/*"
                        withContext(Dispatchers.Main) {
                            activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                        }; "Opened."
                    }
                    "remember" -> {
                        val fact = args.optString("fact").replace(Regex("[\\r\\n]+"), " ").trim().take(500)
                        require(fact.isNotBlank()) { "Empty fact" }
                        synchronized(this@JarvisFilesPlugin) {
                            val lines = if (memory.exists()) memory.readLines() else listOf("# Memory", "")
                            val entry = "- $fact"
                            if (entry !in lines) memory.writeText((lines + entry).joinToString("\n") + "\n")
                        }; "Remembered."
                    }
                    "forget" -> {
                        val match = args.optString("match").trim()
                        require(match.isNotEmpty()) { "Missing match" }
                        synchronized(this@JarvisFilesPlugin) {
                            if (memory.exists()) memory.writeText(memory.readLines().filterNot {
                                it.startsWith("- ") && it.contains(match, true)
                            }.joinToString("\n") + "\n")
                        }; "Forgotten."
                    }
                    else -> error("Unknown tool")
                }
                call.resolve(JSObject().put("result", result))
            } catch (e: Exception) { call.reject(e.message ?: "File operation failed", e) }
        }
    }

    @PluginMethod fun readMemory(call: PluginCall) {
        call.resolve(JSObject().put("text", if (memory.exists()) memory.readText().take(6000) else ""))
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
