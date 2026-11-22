//go:build integration

package demo

import "testing"

func TestAddIntegration(t *testing.T) {
	if Add(Add(1, 2), Add(3, 4)) != 10 {
		t.Fatal("bad")
	}
}
