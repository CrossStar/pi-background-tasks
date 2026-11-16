import { it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDisplay } from '../../src/ui/sanitize-display.ts';

it('removes terminal commands, C1, and incomplete escape sequences', () => {
  for (const control of ['\x1b[2J', '\x1b[1;1H', '\x1b]0;title\x07', '\x1bPpayload\x1b\\', '\x9dtitle\x9c', '\x9b2J', '\x1b(B', '\x08', '\x7f']) {
    assert.equal(sanitizeDisplay(`a${control}b`), 'ab');
  }
  for (const control of ['\x1b', '\x1b[12;', '\x1b]title', '\x1bPpayload', '\x90payload']) {
    assert.equal(sanitizeDisplay(`a${control}`), 'a');
  }
  assert.equal(sanitizeDisplay('a\r\n\tb'), 'a   b');
  assert.equal(sanitizeDisplay('a\nb', false, true), 'a\nb');
  assert.equal(sanitizeDisplay('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(sanitizeDisplay('\x1b[31mred\x1b[0m\x1b[2J', true), '\x1b[31mred\x1b[0m');
});
