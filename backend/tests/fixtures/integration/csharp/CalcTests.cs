using Xunit;
public static class Calc { public static int Add(int a, int b) => a + b; }
public class CalcTests
{
    [Fact] public void AddUnit() => Assert.Equal(3, Calc.Add(1, 2));
    [Fact, Trait("Category", "Integration")] public void AddIntegration() => Assert.Equal(10, Calc.Add(Calc.Add(1, 2), Calc.Add(3, 4)));
}
