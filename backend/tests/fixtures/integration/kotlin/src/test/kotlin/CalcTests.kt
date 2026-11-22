import kotlin.test.Test
import kotlin.test.assertEquals
class CalcTest { @Test fun addUnit() = assertEquals(3, add(1, 2)) }
class CalcIntegrationTest { @Test fun addIntegration() = assertEquals(10, add(add(1, 2), add(3, 4))) }
