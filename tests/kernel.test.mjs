import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelClient, defaultRuntimeDir, defaultPythonPath } from '../server/kernel-client.mjs';

const textOf = (result) => result.outputs.map((o) => o.text || o.data?.['text/plain'] || '').join('\n');

test('real Jupyter bridge persists state, isolates outputs, handles failures and interrupts', { timeout: 120000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'science-kernel-test-'));
  process.env.SCIENCE_TEST_API_KEY = 'test-secret-must-not-reach-kernel';
  const client = new KernelClient({ root });
  t.after(async () => {
    await client.shutdown();
    delete process.env.SCIENCE_TEST_API_KEY;
    await fs.rm(root, { recursive: true, force: true });
  });
  const probe = await client.probe();
  assert.equal(probe.python.available, true);
  assert.equal(path.resolve(probe.python.path), path.resolve(defaultPythonPath()));
  assert.equal(probe.sandboxed, false);
  await assert.rejects(client.create({ cwd: path.dirname(root) }), /inside.*root/);
  const kernel = await client.create({ language: 'python' });
  assert.equal(kernel.status, 'idle');
  assert.equal(kernel.environment.sandboxed, false);
  const events = [];
  client.on('output', (event) => events.push(event));

  await t.test('persistent state and secret environment stripping', async () => {
    const setup = await client.execute({ kernelId: kernel.id, executionId: 'setup', code: 'answer = 40\nprint("setup-only")' });
    assert.equal(setup.status, 'completed');
    const result = await client.execute({ kernelId: kernel.id, executionId: 'answer', code: 'import os\nassert "SCIENCE_TEST_API_KEY" not in os.environ\nprint(answer + 2)' });
    assert.equal(result.status, 'completed');
    assert.match(textOf(result), /42/);
    assert.doesNotMatch(textOf(result), /setup-only/);
    assert.ok(result.executionCount > setup.executionCount);
    assert.ok(result.environment.packages.numpy);
  });

  await t.test('errors leave a usable kernel', async () => {
    const result = await client.execute({ kernelId: kernel.id, code: 'raise ValueError("controlled-test-error")' });
    assert.equal(result.status, 'error');
    assert.ok(result.outputs.some((o) => o.type === 'error' && o.ename === 'ValueError'));
    const healthy = await client.execute({ kernelId: kernel.id, code: 'print(answer)' });
    assert.match(textOf(healthy), /40/);
  });

  await t.test('parallel queued requests never share another execution output', async () => {
    const [a, b] = await Promise.all([
      client.execute({ kernelId: kernel.id, executionId: 'concurrent-a', code: 'import time\nprint("only-a")\ntime.sleep(0.1)' }),
      client.execute({ kernelId: kernel.id, executionId: 'concurrent-b', code: 'print("only-b")' }),
    ]);
    assert.match(textOf(a), /only-a/);
    assert.doesNotMatch(textOf(a), /only-b/);
    assert.match(textOf(b), /only-b/);
    assert.doesNotMatch(textOf(b), /only-a/);
    assert.ok(events.filter((e) => e.executionId === 'concurrent-b').every((e) => !JSON.stringify(e).includes('only-a')));
  });

  await t.test('timeout interrupts or stops a stuck kernel and restart recovers', async () => {
    const result = await client.execute({ kernelId: kernel.id, code: 'import time\ntime.sleep(30)', timeout: 0.3 });
    assert.equal(result.status, 'timeout');
    assert.ok(result.outputs.some((o) => o.ename === 'ExecutionTimeout'));
    const state = (await client.list()).find((k) => k.id === kernel.id);
    if (state.status === 'dead') await client.restart(kernel.id);
    const healthy = await client.execute({ kernelId: kernel.id, code: 'print("after-timeout")' });
    assert.equal(healthy.status, 'completed');
    assert.match(textOf(healthy), /after-timeout/);
  });

  await t.test('interrupt RPC remains responsive while execution is running', async () => {
    const running = client.execute({ kernelId: kernel.id, executionId: 'interrupt-me', code: 'print("running", flush=True)\nwhile True: pass' });
    await new Promise((resolve) => {
      const listener = (event) => {
        if (event.executionId === 'interrupt-me' && event.output.text?.includes('running')) {
          client.off('output', listener);
          resolve();
        }
      };
      client.on('output', listener);
    });
    const interrupted = await client.interrupt(kernel.id);
    assert.equal(interrupted.interrupted, true);
    assert.equal((await running).status, 'interrupted');
  });

  await t.test('matplotlib delivers real PNG rich output', async () => {
    const result = await client.execute({ kernelId: kernel.id, code: 'import matplotlib.pyplot as plt\nplt.plot([1,2,3], [2,4,3])\nplt.show()' });
    assert.equal(result.status, 'completed');
    const image = result.outputs.find((o) => o.data?.['image/png']);
    assert.ok(image);
    assert.equal(Buffer.from(image.data['image/png'], 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  });

  await t.test('runaway display output is visibly capped without breaking the kernel', async () => {
    const result = await client.execute({ kernelId: kernel.id,
      code: 'from IPython.display import display\nfor i in range(550): display(i)' });
    assert.equal(result.status, 'completed');
    assert.equal(result.truncated, true);
    assert.ok(result.outputs.length <= 501);
    assert.ok(result.outputs.some((o) => o.truncated && o.text.includes('Output limit reached')));
  });

  await t.test('resource samples contain measured resident memory', async () => {
    await client.execute({ kernelId: kernel.id, code: 'import time\ntime.sleep(1.3)' });
    const state = (await client.list()).find((k) => k.id === kernel.id);
    assert.ok(state.resources.memoryBytes > 1024 * 1024);
    assert.ok(Number.isFinite(state.resources.cpuPercent));
    assert.equal(state.limits.memoryEnforcement, 'sampled-watchdog');
  });

  await t.test('restart clears state and close removes kernel', async () => {
    await client.restart(kernel.id);
    const cleared = await client.execute({ kernelId: kernel.id, code: 'answer' });
    assert.equal(cleared.status, 'error');
    assert.ok(cleared.outputs.some((o) => o.ename === 'NameError'));
    await client.close(kernel.id);
    assert.equal((await client.list()).length, 0);
  });
});

test('R runtime runs persistent code, handles errors and produces a real plot', { timeout: 45000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'science-r-kernel-test-'));
  const client = new KernelClient({ root });
  t.after(async () => { await client.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal((await client.probe()).r.available, true);
  const kernel = await client.create({ language: 'r' });
  assert.equal(kernel.environmentId, 'r-default');
  assert.match(kernel.environment.r, /R version/);
  assert.ok(kernel.environment.packages.IRkernel);
  const setup = await client.execute({ kernelId: kernel.id, code: 'research_value <- 21' });
  assert.equal(setup.status, 'completed');
  const result = await client.execute({ kernelId: kernel.id, code: 'research_value * 2' });
  assert.equal(result.status, 'completed');
  assert.match(textOf(result), /42/);
  const error = await client.execute({ kernelId: kernel.id, code: 'stop("controlled-R-test-error")' });
  assert.equal(error.status, 'error');
  assert.match(textOf(error), /controlled-R-test-error/);
  const plot = await client.execute({ kernelId: kernel.id,
    code: 'options(jupyter.plot_mimetypes = c("image/png")); plot(c(1,2,3), c(3,1,4))' });
  assert.equal(plot.status, 'completed');
  const png = plot.outputs.find((o) => o.data?.['image/png']);
  assert.ok(png, 'R graph is returned as PNG');
  assert.equal(Buffer.from(png.data['image/png'], 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const exported = await client.exportEnvironment({ environmentId: 'r-default' });
  assert.match(exported.requirements, /IRkernel==/);
});

test('physical packaged worker uses explicit runtime paths and project-local environments', { timeout: 45000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'science-packaged-worker-test-'));
  const workerDir = path.join(root, 'physical-worker');
  await fs.mkdir(workerDir);
  await fs.copyFile(fileURLToPath(new URL('../worker/kernel_worker.py', import.meta.url)), path.join(workerDir, 'kernel_worker.py'));
  const client = new KernelClient({ root, runtimeDir: defaultRuntimeDir(), workerDir });
  t.after(async () => { await client.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  const probe = await client.probe();
  assert.equal(probe.python.available, true);
  assert.equal(probe.r.available, true);
  const kernel = await client.create({ language: 'python' });
  const result = await client.execute({ kernelId: kernel.id, code: 'import sys\nprint(sys.prefix)\nprint(sys.base_prefix)' });
  assert.equal(result.status, 'completed');
  assert.match(textOf(result).replaceAll('\\', '/'), /\.runtime\/python\/cpython-/);
  const environments = await client.listEnvironments();
  assert.equal(environments.find((env) => env.id === 'default').managed, true);
  assert.ok(environments.find((env) => env.id === 'r-default'));
  await assert.rejects(client.installPackages({ packages: ['--extra-index-url=https://example.invalid'] }), /package|URL|flags/);
});

test('memory watchdog stops only its over-limit kernel and reports the actual failure', { timeout: 45000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'science-memory-limit-test-'));
  const client = new KernelClient({ root });
  t.after(async () => { await client.shutdown(); await fs.rm(root, { recursive: true, force: true }); });
  const kernel = await client.create({ language: 'python', maxMemoryBytes: 160 * 1024 * 1024 });
  const result = await client.execute({ kernelId: kernel.id, timeout: 15,
    code: 'memory_test = bytearray(192 * 1024 * 1024)\nimport time\ntime.sleep(12)' });
  assert.equal(result.status, 'error');
  assert.ok(result.outputs.some((output) => output.ename === 'ResourceLimitExceeded'));
  assert.equal((await client.list()).find((item) => item.id === kernel.id).status, 'dead');
  await client.restart(kernel.id);
  const recovered = await client.execute({ kernelId: kernel.id, code: 'print("recovered-after-memory-limit")' });
  assert.equal(recovered.status, 'completed');
  assert.match(textOf(recovered), /recovered-after-memory-limit/);
});
