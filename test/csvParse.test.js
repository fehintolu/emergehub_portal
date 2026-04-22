const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../lib/csvParse');

test('parseCsv handles quotes and commas', () => {
  const rows = parseCsv('"a,b",c\n1,2');
  assert.deepEqual(rows, [
    ['a,b', 'c'],
    ['1', '2'],
  ]);
});

test('parseCsv doubled quotes', () => {
  const rows = parseCsv('"say ""hi""",x\n');
  assert.equal(rows[0][0], 'say "hi"');
});
