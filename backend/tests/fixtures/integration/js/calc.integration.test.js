const test = require('node:test'); const a = require('node:assert'); const { add } = require('./calc');
test('add integration', () => a.strictEqual(add(add(1, 2), add(3, 4)), 10));
