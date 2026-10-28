import test from 'node:test';
import assert from 'node:assert/strict';
import { UpdateGate } from '../lib/update-gate.js';
import { registerCompanionTool } from '../lib/companion-tool.js';
import { registerRuntimeTool } from '../lib/runtime-tool.js';
import { registerGameTool } from '../lib/game-tool.js';

test('idle acquisition is synchronous, operations cannot enter during updates', async () => {
  const gate = new UpdateGate();
  assert.equal(gate.tryAcquireIdleLock(), null);
  const dispose = gate.register(() => false);
  const endOperation = gate.enter();
  assert.equal(gate.tryAcquireIdleLock(), null);
  endOperation(); endOperation();
  const release = gate.tryAcquireIdleLock();
  assert.equal(typeof release, 'function');
  assert.throws(() => gate.hold('browser-new', true), { code: 'plugin_updating' });
  await assert.rejects(gate.run(() => 'mutated'), { code: 'plugin_updating' });
  assert.equal(await gate.run(() => 'status', true), 'status');
  release(); release();
  assert.equal(await gate.run(() => 'finished'), 'finished');
  dispose(); assert.equal(gate.tryAcquireIdleLock(), null);
});

test('busy readers, incomplete operations and editing tabs delay updates', async () => {
  const gate = new UpdateGate(); let busy = true;
  gate.register(() => busy);
  assert.equal(gate.tryAcquireIdleLock(), null);
  busy = false;
  gate.hold('browser-one', true); gate.hold('browser-two', true);
  gate.hold('browser-one', false); assert.equal(gate.tryAcquireIdleLock(), null);
  gate.hold('browser-two', false);
  gate.hold('expired-tab', true, Date.now() - 31000);
  const release = gate.tryAcquireIdleLock(); assert.equal(typeof release, 'function'); release();
  await assert.rejects(gate.run(() => { throw new Error('failed operation'); }), /failed operation/);
  const unlocked = gate.tryAcquireIdleLock(); assert.equal(typeof unlocked, 'function'); unlocked();
  assert.throws(() => gate.hold('../invalid', true), /invalid_update_hold/);
});

test('all three tools share the update gate including persona prepare and activity export', async () => {
  const gate = new UpdateGate(); gate.register(() => false);
  const registrations = new Map(); let calls = 0;
  const ctx = { on() {}, tools: { register(tool) { registrations.set(tool.name, tool); } } };
  const withOperation = (work, readOnly) => gate.run(work, readOnly);
  registerCompanionTool(ctx, { bridge: { publicStatus: () => ({}), prepare() { calls++; } }, publicState: () => ({}), discovery: () => ({}), withOperation });
  registerRuntimeTool(ctx, { runtime: { publicStatus: () => ({}), exportActivity() { calls++; } }, connection: { publicStatus: () => ({}) }, withOperation });
  registerGameTool(ctx, { status: () => ({}), start() { calls++; } }, { withOperation });
  const exec = { signal: new AbortController().signal };
  const release = gate.tryAcquireIdleLock();
  for (const [name, args] of [
    ['tangui_companion', { action: 'prepare', memoryDir: 'C:/test-memory' }],
    ['tangui_community', { action: 'export_activity' }],
    ['tangui_game', { action: 'start' }],
  ]) await assert.rejects(registrations.get(name).execute(args, exec), { code: 'plugin_updating' });
  for (const name of registrations.keys()) await registrations.get(name).execute({ action: 'status' }, exec);
  assert.equal(calls, 0); release();
});
