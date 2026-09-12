package xyz.block.buzz.mobile

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ClientStateControllerTest {
    @Test
    fun scopeChangeClosesTheOldHandleAndCommandsUseTheNewOne() {
        val native = FakeNative()
        val controller = ClientStateController(native)

        assertTrue(controller.open("state.db", "https://one", "aa"))
        assertTrue(controller.open("state.db", "https://one", "aa"))
        assertEquals(1, native.opens)

        assertTrue(controller.open("state.db", "https://two", "bb"))
        assertEquals(listOf(1L), native.closed)
        assertEquals("2:{\"op\":\"flush\"}", controller.execute("{\"op\":\"flush\"}"))

        controller.close()
        assertEquals(listOf(1L, 2L), native.closed)
    }

    @Test
    fun unavailableLibraryFailsClosedWithoutOpening() {
        val native = FakeNative(isAvailable = false)
        val controller = ClientStateController(native)

        assertFalse(controller.open("state.db", "https://one", "aa"))
        assertEquals(0, native.opens)
    }
}

private class FakeNative(
    override val isAvailable: Boolean = true,
) : ClientStateNativeApi {
    var opens = 0
    val closed = mutableListOf<Long>()

    override fun open(path: String, relayUrl: String, viewerPubkey: String): Long {
        opens += 1
        return opens.toLong()
    }

    override fun execute(handle: Long, requestJson: String): String = "$handle:$requestJson"

    override fun close(handle: Long) {
        closed.add(handle)
    }
}
