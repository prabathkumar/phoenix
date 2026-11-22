package demo; import org.junit.Test; import static org.junit.Assert.*; public class CalcIT { @Test public void addIntegration(){ assertEquals(10, Calc.add(Calc.add(1,2),Calc.add(3,4))); } }
