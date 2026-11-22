<?php
use PHPUnit\Framework\TestCase;
use Demo\Calc;
final class CalcTest extends TestCase { public function testAddUnit(): void { $this->assertSame(3, Calc::add(1, 2)); } }
