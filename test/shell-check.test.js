import test from 'node:test';
import assert from 'node:assert/strict';
import {shellAvailable} from '../src/server.js';

test('PowerShell check reports a missing shell on Windows and never blocks macOS',async()=>{
  assert.equal(await shellAvailable('local-tunnel-no-such-shell','win32'),false);
  assert.equal(await shellAvailable('local-tunnel-no-such-shell','darwin'),true);
});
