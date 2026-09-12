package xyz.block.buzz.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
class ClientStateNativeInstrumentedTest {
    @Test
    fun packagedNativeBridgeOpensAndQueriesSqlite() {
        assertTrue(ClientStateNative.isAvailable, "client-state JNI library did not load")

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val database = context.noBackupFilesDir.resolve(
            "client-state-instrumented-${System.nanoTime()}.sqlite",
        )
        var handle = 0L
        try {
            handle = ClientStateNative.open(
                database.path,
                "wss://instrumented.invalid",
                "00".repeat(32),
            )
            assertTrue(handle != 0L)

            val response = JSONObject(
                ClientStateNative.execute(
                    handle,
                    """{"op":"channels","members_only":true}""",
                ),
            )
            assertTrue(response.getBoolean("ok"), response.optString("error"))
            assertEquals(0, response.getJSONArray("value").length())
        } finally {
            if (handle != 0L) ClientStateNative.close(handle)
            database.delete()
            database.resolveSibling("${database.name}-shm").delete()
            database.resolveSibling("${database.name}-wal").delete()
        }
    }
}
