const test = require('node:test'); const a = require('node:assert'); const { add } = require('./calc');
test('add unit', () => a.strictEqual(add(1, 2), 3));
