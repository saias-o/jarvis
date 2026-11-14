package dev.jarvis.app

import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.ai.edge.litertlm.*
import com.google.gson.Gson
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File

@CapacitorPlugin(name = "JarvisLlm")
class JarvisLlmPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private var engine: Engine? = null
    @Volatile private var conversation: Conversation? = null
    @Volatile private var generating = false
    private var modelPath = ""
    private var backend = ""
    private var releaseJob: Job? = null
    private val gson = Gson()

    private fun background(call: PluginCall, block: suspend () -> JSObject) {
        scope.launch {
            try { mutex.withLock { call.resolve(block()) } }
            catch (e: Exception) { call.reject(e.message ?: "Local model failed", e) }
        }
    }

    @PluginMethod
    fun load(call: PluginCall) = background(call) {
        val file = File(call.getString("modelPath") ?: "").canonicalFile
        val models = File(context.filesDir, "models").canonicalFile
        require(file.path.startsWith(models.path + File.separator) && file.isFile) {
            "Import or download a .litertlm model first"
        }
        if (engine != null && modelPath == file.path) return@background state()
        engine?.close()
        engine = null
        modelPath = ""
        val requested = call.getString("backend") ?: "gpu"
        fun initialise(target: Backend): Engine {
            val candidate = Engine(EngineConfig(
                modelPath = file.path, backend = target,
                cacheDir = context.cacheDir.path, maxNumTokens = 4096,
            ))
            try { candidate.initialize(); return candidate }
            catch (e: Exception) { candidate.close(); throw e }
        }
        backend = requested
        engine = if (requested == "cpu") initialise(Backend.CPU()) else {
            try { initialise(Backend.GPU()) }
            catch (_: Exception) { backend = "cpu"; initialise(Backend.CPU()) }
        }
        modelPath = file.path
        state()
    }

    private fun state() = JSObject().put("loaded", engine != null)
        .put("modelPath", modelPath).put("backend", backend).put("busy", generating)

    @PluginMethod fun status(call: PluginCall) { call.resolve(state()) }

    private fun message(item: JSONObject): Message {
        val text = item.optString("content")
        return when (item.optString("role")) {
            "system" -> Message.system(text)
            "assistant" -> {
                val calls = item.optJSONArray("tool_calls")
                Message.model(Contents.of(text), (0 until (calls?.length() ?: 0)).map { i ->
                    val f = calls!!.getJSONObject(i).getJSONObject("function")
                    @Suppress("UNCHECKED_CAST")
                    val args = gson.fromJson(f.optJSONObject("arguments")?.toString() ?: "{}", Map::class.java) as Map<String, Any?>
                    ToolCall(f.getString("name"), args)
                })
            }
            "tool" -> Message.tool(Contents.of(Content.ToolResponse(item.getString("tool_name"), text)))
            else -> Message.user(text)
        }
    }

    @PluginMethod
    fun generate(call: PluginCall) {
        if (generating) { call.reject("A generation is already running"); return }
        generating = true
        background(call) {
            try {
                val runtime = engine ?: error("Load the local model first")
                val messages = call.getArray("messages") ?: error("Missing messages")
                require(messages.length() > 0)
                val specs = call.getArray("tools") ?: JSArray()
                val providers = (0 until specs.length()).map { i ->
                    val spec = specs.getJSONObject(i).getJSONObject("function").toString()
                    tool(object : OpenApiTool {
                        override fun getToolDescriptionJsonString() = spec
                        override fun execute(paramsJsonString: String): String = error("Tools are executed by JavaScript")
                    })
                }
                runtime.createConversation(ConversationConfig(
                    initialMessages = (0 until messages.length() - 1).map { message(messages.getJSONObject(it)) },
                    tools = providers, automaticToolCalling = false,
                    samplerConfig = SamplerConfig(topK = 40, topP = 0.95, temperature = 0.3),
                    maxOutputToken = 768,
                    thinkingConfig = ThinkingConfig(enableThinking = false),
                )).use { chat ->
                    conversation = chat
                    chat.sendMessageAsync(message(messages.getJSONObject(messages.length() - 1))).collect { chunk ->
                        val calls = JSArray()
                        chunk.toolCalls.forEach { c -> calls.put(JSObject().put("function",
                            JSObject().put("name", c.name).put("arguments", JSONObject(gson.toJson(c.arguments))))) }
                        notifyListeners("token", JSObject().put("id", call.getString("id"))
                            .put("message", JSObject().put("content", chunk.toString()).put("tool_calls", calls)))
                    }
                }
                JSObject()
            } finally { conversation = null; generating = false }
        }
    }

    @PluginMethod fun cancel(call: PluginCall) {
        runCatching { conversation?.cancelProcess() }
        call.resolve()
    }

    @PluginMethod fun unload(call: PluginCall) {
        runCatching { conversation?.cancelProcess() }
        background(call) { engine?.close(); engine = null; modelPath = ""; state() }
    }

    override fun handleOnPause() {
        releaseJob = scope.launch {
            delay(120_000)
            runCatching { conversation?.cancelProcess() }
            mutex.withLock { engine?.close(); engine = null; modelPath = "" }
        }
    }
    override fun handleOnResume() { releaseJob?.cancel() }
    override fun handleOnDestroy() {
        runCatching { conversation?.cancelProcess() }
        scope.launch { mutex.withLock { engine?.close(); engine = null }; scope.cancel() }
    }
}
