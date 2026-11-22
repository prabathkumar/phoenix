import pytest
from calc import add

def test_add_unit():
    assert add(1, 2) == 3

@pytest.mark.integration
def test_add_integration():
    assert add(add(1, 2), add(3, 4)) == 10
