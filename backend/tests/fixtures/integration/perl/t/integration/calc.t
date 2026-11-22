use Test::More tests => 1;
use Calc;
is(Calc::add(Calc::add(1,2), Calc::add(3,4)), 10, "add integration");
