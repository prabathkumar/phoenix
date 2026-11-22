@Tags(['integration'])
library;
import 'package:test/test.dart';
import 'package:demo/calc.dart';
void main() { test('add integration', () => expect(add(add(1, 2), add(3, 4)), 10)); }
