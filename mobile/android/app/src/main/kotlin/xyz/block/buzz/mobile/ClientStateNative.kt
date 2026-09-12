package xyz.block.buzz.mobile

import android.content.Context
import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.Executors

internal interface ClientStateNativeApi {
    val isAvailable: Boolean

    fun open(path: String, relayUrl: String, viewerPubkey: String): Long

    fun execute(handle: Long, requestJson: String): String

    fun close(handle: Long)
}

internal object ClientStateNative : ClientStateNativeApi {
    private val loadResult = runCatching {
        System.loadLibrary("buzz_client_state_android")
    }

    override val isAvailable: Boolean
        get() = loadResult.isSuccess

    override external fun open(path: String, relayUrl: String, viewerPubkey: String): Long

    override external fun execute(handle: Long, requestJson: String): String

    override external fun close(handle: Long)
}

internal class ClientStateController(
    private val native: ClientStateNativeApi,
) {
    private var handle = 0L
    private var scope: Pair<String, String>? = null

    @Synchronized
    fun open(path: String, relayUrl: String, viewerPubkey: String): Boolean {
        if (!native.isAvailable) return false
        val nextScope = relayUrl to viewerPubkey
        if (handle != 0L && scope == nextScope) return true
        close()
        handle = native.open(path, relayUrl, viewerPubkey)
        check(handle != 0L) { "native client-state open returned an invalid handle" }
        scope = nextScope
        return true
    }

    @Synchronized
    fun execute(requestJson: String): String {
        check(handle != 0L) { "native client-state is not open" }
        return native.execute(handle, requestJson)
    }

    @Synchronized
    fun close() {
        if (handle != 0L) native.close(handle)
        handle = 0L
        scope = null
    }
}

internal class ClientStatePlugin(
    context: Context,
    messenger: BinaryMessenger,
    native: ClientStateNativeApi = ClientStateNative,
) : MethodChannel.MethodCallHandler {
    private val channel = MethodChannel(messenger, CHANNEL_NAME)
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "buzz-client-state-jni")
    }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val controller = ClientStateController(native)
    private val nativeApi = native
    private val databasePath = context.noBackupFilesDir.resolve("buzz-client-state.sqlite").path

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "isSupported" -> result.success(nativeApi.isAvailable)
            "open" -> open(call, result)
            "execute" -> execute(call, result)
            "close" -> runOffMain(result) {
                controller.close()
                null
            }
            else -> result.notImplemented()
        }
    }

    private fun open(call: MethodCall, result: MethodChannel.Result) {
        val relayUrl = call.argument<String>("relayUrl")?.trim()
        val viewerPubkey = call.argument<String>("viewerPubkey")?.trim()
        if (relayUrl.isNullOrEmpty() || viewerPubkey.isNullOrEmpty()) {
            result.error("invalid_arguments", "relayUrl and viewerPubkey are required", null)
            return
        }
        runOffMain(result) {
            controller.open(databasePath, relayUrl, viewerPubkey)
        }
    }

    private fun execute(call: MethodCall, result: MethodChannel.Result) {
        val requestJson = call.arguments as? String
        if (requestJson == null || requestJson.length > MAX_REQUEST_CHARACTERS) {
            result.error("invalid_arguments", "a bounded JSON command is required", null)
            return
        }
        runOffMain(result) { controller.execute(requestJson) }
    }

    private fun runOffMain(result: MethodChannel.Result, block: () -> Any?) {
        executor.execute {
            try {
                val value = block()
                mainHandler.post { result.success(value) }
            } catch (error: Exception) {
                mainHandler.post {
                    result.error("client_state_failed", error.message ?: error.javaClass.name, null)
                }
            }
        }
    }

    fun dispose() {
        channel.setMethodCallHandler(null)
        executor.execute { controller.close() }
        executor.shutdown()
    }

    private companion object {
        const val CHANNEL_NAME = "buzz/client_state"
        const val MAX_REQUEST_CHARACTERS = 8 * 1024 * 1024
    }
}
