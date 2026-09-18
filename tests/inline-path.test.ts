import { describe, expect, it } from 'vitest';
import { resolveInlineExecutionViolation } from '../src/rules.js';
import { BLOCK_REASON_PROTECTED_PATH } from '../src/config.js';

describe('protected paths embedded in inline code', () => {
  const root = '/tmp/aegis-protected/canary.txt';
  it.each([
    `node -e 'require("fs").writeFileSync("${root}","CHANGED")'`,
    `/usr/bin/node -e 'require("fs").readFileSync("${root}")'`,
    `python3 -c 'open("${root}","w").write("CHANGED")'`,
    `/opt/python3.11 -c 'open("${root}").read()'`,
    `node -e 'require("fs").readFileSync("\\x2ftmp/aegis-protected/canary.txt")'`,
  ])('blocks the actual literal path in %s', (command) => {
    expect(resolveInlineExecutionViolation(command, [root], '/tmp')).toBe(BLOCK_REASON_PROTECTED_PATH);
  });
  it('allows an unrelated file and plain computation', () => {
    expect(resolveInlineExecutionViolation('node -e \'require("fs").writeFileSync("notes.txt","OK")\'', [root], '/tmp')).toBeUndefined();
    expect(resolveInlineExecutionViolation('python3 -c \'print(1 + 1)\'', [root], '/tmp')).toBeUndefined();
  });
});
