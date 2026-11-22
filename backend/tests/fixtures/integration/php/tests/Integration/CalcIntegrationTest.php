<?php
use PHPUnit\Framework\TestCase;
use Demo\Calc;
/** @group integration */
final class CalcIntegrationTest extends TestCase { public function testAddIntegration(): void { $this->assertSame(10, Calc::add(Calc::add(1, 2), Calc::add(3, 4))); } }
