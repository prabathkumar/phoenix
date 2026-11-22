import { add } from '../src/calc';
describe('calc e2e', () => { it('add integration', () => expect(add(add(1, 2), add(3, 4))).toBe(10)); });
