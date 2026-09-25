import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Theme, type ThemeColor } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  BackgroundTasksManager,
  type BackgroundTaskForUi,
} from '../../src/ui/background-tasks-manager.js';
import { stripAnsi } from '../helpers/normalize.js';

const themeColors: readonly ThemeColor[] = [
  'accent',
  'border',
  'borderAccent',
  'borderMuted',
  'success',
  'error',
  'warning',
  'muted',
  'dim',
  'text',
  'thinkingText',
  'userMessageText',
  'customMessageText',
  'customMessageLabel',
  'toolTitle',
  'toolOutput',
  'mdHeading',
  'mdLink',
  'mdLinkUrl',
  'mdCode',
  'mdCodeBlock',
  'mdCodeBlockBorder',
  'mdQuote',
  'mdQuoteBorder',
  'mdHr',
  'mdListBullet',
  'toolDiffAdded',
  'toolDiffRemoved',
  'toolDiffContext',
  'syntaxComment',
  'syntaxKeyword',
  'syntaxFunction',
  'syntaxVariable',
  'syntaxString',
  'syntaxNumber',
  'syntaxType',
  'syntaxOperator',
  'syntaxPunctuation',
  'thinkingOff',
  'thinkingMinimal',
  'thinkingLow',
  'thinkingMedium',
  'thinkingHigh',
  'thinkingXhigh',
  'bashMode',
];
const themeBackgrounds = [
  'selectedBg',
  'userMessageBg',
  'customMessageBg',
  'toolPendingBg',
  'toolSuccessBg',
  'toolErrorBg',
] as const;
type ThemeForegrounds = ConstructorParameters<typeof Theme>[0];
type ThemeBackgrounds = ConstructorParameters<typeof Theme>[1];
const theme = new Theme(
  Object.fromEntries(themeColors.map((color) => [color, '#ffffff'])) as ThemeForegrounds,
  Object.fromEntries(themeBackgrounds.map((color) => [color, '#000000'])) as ThemeBackgrounds,
  'truecolor',
);

function task(overrides: Partial<BackgroundTaskForUi> = {}): BackgroundTaskForUi {
  const now = Date.now();
  return {
    id: 'b12345678',
    name: 'Component Task',
    command: 'printf component-ok',
    status: 'running',
    outputPath: '.pi/tasks/test/b12345678.output',
    outputAbsPath: join(tmpdir(), 'missing-output'),
    cwd: tmpdir(),
    startTime: now - 1000,
    bytesWritten: 0,
    isAgent: false,
    notified: false,
    notifyOnCompletion: true,
    triggerOnCompletion: false,
    ...overrides,
  };
}

function manager(
  options: Partial<ConstructorParameters<typeof BackgroundTasksManager>[3]> = {},
  tasks: BackgroundTaskForUi[] = [task()],
) {
  let closed = false;
  let renders = 0;
  const stopped: string[] = [];
  const paths: string[] = [];
  const seen = new Set<string>();
  const instance = new BackgroundTasksManager(
    {
      requestRender: () => {
        renders++;
      },
    },
    theme,
    () => {
      closed = true;
    },
    {
      getTasks: () => tasks,
      stopTask: (t) => {
        stopped.push(t.id);
        t.status = 'killed';
        t.endTime = Date.now();
        return Promise.resolve();
      },
      stopAllRunning: () => {
        const running = tasks.filter((t) => t.status === 'running');
        for (const t of running) {
          stopped.push(t.id);
          t.status = 'killed';
          t.endTime = Date.now();
        }
        return Promise.resolve({ stopped: running.length, failures: [] });
      },
      rerunTask: (t) => {
        const overrides: Partial<BackgroundTaskForUi> = {
          id: `babcdef${String(tasks.length)}`,
          name: t.name,
          command: t.command,
          startTime: Date.now(),
        };
        if (t.description !== undefined) overrides.description = t.description;
        if (t.timeoutSeconds !== undefined) overrides.timeoutSeconds = t.timeoutSeconds;
        const rerun = task(overrides);
        tasks.unshift(rerun);
        return Promise.resolve(rerun);
      },
      showOutputPath: (t) => {
        paths.push(t.outputPath);
      },
      markSeen: (id) => {
        seen.add(id);
      },
      markFinishedSeen: (ids) => {
        for (const id of ids) seen.add(id);
      },
      isSeen: (id) => seen.has(id),
      ...options,
    },
  );
  return {
    instance,
    get closed() {
      return closed;
    },
    get renders() {
      return renders;
    },
    stopped,
    paths,
    seen,
  };
}

function assertWidth(lines: string[], width: number) {
  for (const line of lines) assert.ok(visibleWidth(stripAnsi(line)) <= width, line);
}

void describe('BackgroundTasksManager component', () => {
  void it('scrolls only the hovered log body in wide, narrow and detail layouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bg-wheel-'));
    const output = join(root, 'log');
    await writeFile(output, Array.from({ length: 40 }, (_, i) => `wheel-row-${String(i).padStart(2, '0')}`).join('\n') + '\n');
    try {
      for (const layout of ['wide', 'narrow', 'detail'] as const) {
        const width = layout === 'narrow' ? 70 : 120;
        const h = manager({ getHeight: () => 40, ...(layout === 'detail' ? { initialTaskId: 'b12345678' } : {}) }, [task({ outputAbsPath: output })]);
        try {
          const deadline = performance.now() + 5000;
          let lines: string[];
          do {
            lines = h.instance.render(width).map(stripAnsi);
            if (lines.some((line) => line.includes('wheel-row-39'))) break;
            assert.ok(performance.now() < deadline, 'log preview should load');
            await new Promise((resolve) => setTimeout(resolve, 10));
          } while (true);
          const y = lines.findIndex((line) => line.includes('wheel-row-39'));
          const x = lines[y]?.indexOf('wheel-row-39') ?? -1;
          assert.equal(h.instance.handleMouse({ type: 'wheel', x: 0, y, wheelDelta: -3 }), undefined);
          assert.equal(h.instance.handleMouse({ type: 'wheel', x, y: 1, wheelDelta: -3 }), undefined);
          assert.deepEqual(h.instance.handleMouse({ type: 'wheel', x, y, wheelDelta: -3 }), { handled: true, render: true });
          let text = stripAnsi(h.instance.render(width).join('\n'));
          assert.match(text, /paused/);
          assert.match(text, /wheel-row-25/);
          assert.doesNotMatch(text, /wheel-row-39/);
          h.instance.handleMouse({ type: 'wheel', x, y, wheelDelta: 100 });
          text = stripAnsi(h.instance.render(width).join('\n'));
          assert.match(text, /following tail/);
          assert.match(text, /wheel-row-39/);
          h.instance.handleInput('v');
          h.instance.render(width);
          assert.equal(h.instance.handleMouse({ type: 'wheel', x, y, wheelDelta: -3 }), undefined);
        } finally { h.instance.dispose(); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  void it('refreshes tqdm carriage-return frames instead of showing stale concatenated progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bg-progress-'));
    const output = join(root, 'log');
    const initial = 'CHECKPOINT start\r\n\rprogress 1/360\rprogress 2/360';
    await writeFile(output, initial);
    const h = manager({ initialTaskId: 'b12345678' }, [task({ outputAbsPath: output })]);
    const waitForText = async (pattern: RegExp) => {
      const deadline = performance.now() + 5000;
      while (!pattern.test(stripAnsi(h.instance.render(100).join('\n')))) {
        assert.ok(performance.now() < deadline, `expected ${pattern}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitForText(/progress 2\/360/);
      let rendered = stripAnsi(h.instance.render(100).join('\n'));
      assert.match(rendered, /CHECKPOINT start/);
      assert.doesNotMatch(rendered, /progress 1\/360/);
      await writeFile(output, initial + '\r\x1b[32mprogress 3/360\x1b[0m\r');
      await waitForText(/progress 3\/360/);
      rendered = stripAnsi(h.instance.render(100).join('\n'));
      assert.doesNotMatch(rendered, /progress 2\/360/);
      await writeFile(output, initial + '\rprogress 360/360\r\nDEMO_COMPLETE\r\n');
      await waitForText(/DEMO_COMPLETE/);
      assert.match(stripAnsi(h.instance.render(100).join('\n')), /progress 360\/360/);
    } finally { h.instance.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  void it('shows the complete wrapped command with scrolling and exact copying', async () => {
    const command = 'node script.js ' + '--参数=value '.repeat(100) + '\nFINAL_COMMAND_ARGUMENT';
    const copied: string[] = [];
    const h = manager({ getHeight: () => 16, copyText: async (text) => { copied.push(text); } }, [task({ command })]);
    try {
      h.instance.render(60);
      h.instance.handleInput('v');
      let lines = h.instance.render(60);
      assert.match(stripAnsi(lines.join('\n')), /Full command:/);
      assert.doesNotMatch(stripAnsi(lines.join('\n')), /FINAL_COMMAND_ARGUMENT/);
      assertWidth(lines, 60);
      assert.ok(lines.length <= 16);
      h.instance.handleInput('\x1b[F');
      lines = h.instance.render(60);
      assert.match(stripAnsi(lines.join('\n')), /FINAL_COMMAND_ARGUMENT/);
      assertWidth(h.instance.render(32), 32);
      h.instance.handleInput('y');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(copied, [command]);
      h.instance.handleInput('\x1b');
      assert.equal(h.closed, false);
      assert.match(stripAnsi(h.instance.render(60).join('\n')), /bg tasks focused/);
      h.instance.handleInput('\r');
      h.instance.handleInput('v');
      assert.match(stripAnsi(h.instance.render(60).join('\n')), /Full command:/);
    } finally { h.instance.dispose(); }
  });

  void it('previews without clearing unread, filters failures, searches full logs and copies paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bg-monitor-'));
    const output = join(root, 'log');
    await writeFile(output, 'early-match\n' + 'padding\n'.repeat(20000) + 'latest-output\n');
    const failed = task({ id: 'bfail', name: 'Failure', status: 'failed', exitCode: 7, error: 'bad input', outputAbsPath: output });
    const running = task({ outputAbsPath: output });
    const copied: string[] = [];
    const opened: string[] = [];
    const h = manager({ copyText: async (text) => { copied.push(text); }, openOutput: async (t) => { opened.push(t.id); } }, [running, failed]);
    const waitText = async (expected: RegExp) => {
      const deadline = performance.now() + 5000;
      while (!expected.test(stripAnsi(h.instance.render(130).join('\n')))) {
        assert.ok(performance.now() < deadline, `expected ${expected}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      await waitText(/latest-output/);
      h.instance.handleInput('3');
      await waitText(/bad input/);
      assert.equal(h.seen.size, 0);
      h.instance.handleInput('/');
      h.instance.handleInput('early-match');
      h.instance.handleInput('\r');
      await waitText(/Match at byte 0/);
      assert.match(stripAnsi(h.instance.render(130).join('\n')), /early-match/);
      for (const key of ['y', 'p', 'o']) h.instance.handleInput(key);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(copied, [failed.command, output]);
      assert.deepEqual(opened, [failed.id]);
      for (const width of [32, 60, 100, 160]) assertWidth(h.instance.render(width), width);
      h.instance.handleInput('1');
      assert.match(stripAnsi(h.instance.render(130).join('\n')), /Running/);
      h.instance.handleInput('q');
      assert.equal(h.closed, true);
    } finally { h.instance.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  void it('freezes scrolled output, reports appended lines, and resumes following', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bg-monitor-follow-'));
    const output = join(root, 'log');
    const initial = Array.from({ length: 40 }, (_, i) => `row-${i}`).join('\n') + '\n';
    await writeFile(output, initial);
    const h = manager({ initialTaskId: 'b12345678' }, [task({ outputAbsPath: output })]);
    const waitText = async (expected: RegExp) => {
      const deadline = performance.now() + 5000;
      while (!expected.test(stripAnsi(h.instance.render(120).join('\n')))) {
        assert.ok(performance.now() < deadline, `expected ${expected}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitText(/row-39/);
      h.instance.handleInput('\x1b[A');
      await writeFile(output, initial + 'arrived-one\narrived-two\n');
      await waitText(/2 new lines/);
      assert.doesNotMatch(stripAnsi(h.instance.render(120).join('\n')), /arrived-two/);
      h.instance.handleInput('f');
      await waitText(/arrived-two/);
    } finally { h.instance.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  void it('fits short terminals and preserves selected task identity after reordering', () => {
    const first = task({ id: 'bfirst', name: 'First Selected', startTime: 100 });
    const second = task({ id: 'bsecond', name: 'Other Task', startTime: 50 });
    const h = manager({ getHeight: () => 20 }, [first, second]);
    try {
      h.instance.render(120);
      second.startTime = 200;
      const lines = h.instance.render(120);
      assert.ok(lines.length <= 20);
      const selected = stripAnsi(lines.join('\n'));
      assert.match(selected, /›.*First Selected/);
      for (const width of [32, 60, 120]) {
        assertWidth(h.instance.render(width), width);
        assert.ok(h.instance.render(width).length <= 20);
      }
    } finally { h.instance.dispose(); }
  });

  void it('renders list within width and handles selection/actions', async () => {
    const baseTime = Date.now();
    const tasks = [
      task({ id: 'b11111111', name: 'First Task', startTime: baseTime + 1000 }),
      task({ id: 'b22222222', name: 'Second Task', startTime: baseTime }),
    ];
    const h = manager({}, tasks);
    try {
      const lines = h.instance.render(90);
      assert.match(stripAnsi(lines.join('\n')), /bg tasks focused/);
      assert.match(stripAnsi(lines.join('\n')), /First Task/);
      assertWidth(lines, 90);

      h.instance.handleInput('\x1b[B');
      h.instance.handleInput('k');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(h.stopped, ['b22222222']);

      h.instance.handleInput('h');
      h.instance.handleInput('R');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.ok(tasks.some((candidate) => candidate.id.startsWith('babcdef')));

      h.instance.handleInput('c');
      assert.ok(h.paths.length >= 1);

      h.instance.handleInput('x');
      assert.equal(h.closed, true);
    } finally {
      h.instance.dispose();
    }
  });

  void it('keeps telemetry out of previews and shows only reported agent details', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-context-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      await writeFile(outputAbsPath, 'context-output\n', 'utf8');
      const tasks = [
        task({
          id: 'bctx00001',
          name: 'Context Task',
          outputAbsPath,
          isAgent: true,
          model: 'openai-codex/gpt-5.5',
          contextUsage: { tokens: 42_000, contextWindow: 200_000, percent: 21 },
          tokenUsage: {
            input: 1000,
            output: 200,
            cacheRead: 30,
            cacheWrite: 20,
            totalTokens: 1250,
          },
          toolUsage: { total: 3, failed: 1, byName: { bash: 2, read: 1 } },
        }),
        task({
          id: 'bctx00002',
          name: 'No Context Task',
          outputAbsPath,
          startTime: Date.now() - 2000,
        }),
      ];
      const h = manager({}, tasks);
      try {
        let text = stripAnsi(h.instance.render(120).join('\n'));
        assert.doesNotMatch(text, /ctx |model gpt|tok 1|tools 3|not reported/);
        h.instance.handleInput('\x1b[B');
        assert.doesNotMatch(stripAnsi(h.instance.render(120).join('\n')), /ctx |not reported/);
        h.instance.handleInput('\x1b[A');
        h.instance.render(120);
        h.instance.handleInput('\r');
        await new Promise((resolve) => setTimeout(resolve, 20));
        text = stripAnsi(h.instance.render(120).join('\n'));
        assert.match(text, /Model: openai-codex\/gpt-5\.5/);
        assert.match(text, /Context: 21\.0% of 200k window \(42k tokens\)/);
        assert.match(
          text,
          /Tokens: input 1\.0k · output 200 · cache read 30 · cache write 20 · total 1\.3k/,
        );
        assert.match(text, /Tools: 3 total · 1 failed · bash 2 · read 1/);
        h.instance.handleInput('\x1b[D');
        h.instance.handleInput('\x1b[B');
        h.instance.handleInput('\r');
        await new Promise((resolve) => setTimeout(resolve, 20));
        text = stripAnsi(h.instance.render(120).join('\n'));
        assert.doesNotMatch(text, /Model:|Context:|Tokens:|Tools:|not reported/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('opens detail, reads bounded tail, refreshes, acts, and returns to list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-component-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      await writeFile(outputAbsPath, 'line one\ncomponent-tail\n', 'utf8');
      const tasks = [task({ outputAbsPath, bytesWritten: 24 })];
      const h = manager({ initialTaskId: 'b12345678' }, tasks);
      try {
        const deadline = performance.now() + 5000;
        while (!stripAnsi(h.instance.render(100).join('\n')).includes('component-tail')) {
          assert.ok(performance.now() < deadline, 'detail output should finish loading');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        let text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /bg: Component Task/);
        assert.match(text, /component-tail/);
        assert.ok(h.seen.has('b12345678'));

        h.instance.handleInput('r');
        h.instance.handleInput('c');
        h.instance.handleInput('k');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(h.paths, ['.pi/tasks/test/b12345678.output']);
        assert.deepEqual(h.stopped, ['b12345678']);
        h.instance.handleInput('R');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.ok(tasks.some((candidate) => candidate.id.startsWith('babcdef')));

        h.instance.handleInput('\x1b[D');
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /bg tasks focused/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('scrolls the detail output tail with arrows/pages and resumes follow at the bottom', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-scroll-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      const fileLines = Array.from(
        { length: 40 },
        (_, i) => `LINE-${String(i + 1).padStart(3, '0')}`,
      );
      await writeFile(outputAbsPath, `${fileLines.join('\n')}\n`, 'utf8');
      const h = manager({ initialTaskId: 'b12345678' }, [
        task({ outputAbsPath, bytesWritten: 400 }),
      ]);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        let text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /following tail/);
        assert.match(text, /LINE-040/);
        assert.match(text, /LINE-029/);
        assert.doesNotMatch(text, /LINE-001/);
        assert.doesNotMatch(text, /LINE-005/);

        // Scroll up 20 lines: pauses follow, reveals earlier lines, hides the latest.
        for (let i = 0; i < 20; i++) h.instance.handleInput('\x1b[A');
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /lines 9\u201320 of 40/);
        assert.match(text, /LINE-009/);
        assert.match(text, /LINE-020/);
        assert.doesNotMatch(text, /LINE-040/);

        // PageUp reaches the top of the buffer.
        h.instance.handleInput('\x1b[5~');
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /lines 1\u201312 of 40/);
        assert.match(text, /LINE-001/);

        // Paging back past the end resumes the live tail.
        h.instance.handleInput('\x1b[6~');
        h.instance.handleInput('\x1b[6~');
        h.instance.handleInput('\x1b[6~');
        await new Promise((resolve) => setTimeout(resolve, 20));
        text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /following tail/);
        assert.match(text, /LINE-040/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('does not enter scroll mode when the output fits the detail window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-bg-noscroll-'));
    try {
      const outputAbsPath = join(dir, 'task.output');
      await writeFile(outputAbsPath, 'only-line-a\nonly-line-b\nonly-line-c\n', 'utf8');
      const h = manager({ initialTaskId: 'b12345678' }, [
        task({ outputAbsPath, bytesWritten: 33 }),
      ]);
      try {
        const deadline = Date.now() + 5000;
        while (!stripAnsi(h.instance.render(100).join('\n')).includes('only-line-c')) {
          assert.ok(Date.now() < deadline, 'detail output should load before scrolling');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        h.instance.handleInput('\x1b[A');
        h.instance.handleInput('\x1b[A');
        const text = stripAnsi(h.instance.render(100).join('\n'));
        assert.match(text, /only-line-c/);
        assert.match(text, /following tail/);
        assert.doesNotMatch(text, /lines \d+\u2013\d+ of/);
      } finally {
        h.instance.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  void it('requires confirmation before stopping all running tasks and reports no-op clearly', async () => {
    const tasks = [task({ id: 'b11111111' }), task({ id: 'b22222222' })];
    const h = manager({}, tasks);
    try {
      h.instance.handleInput('a');
      assert.deepEqual(h.stopped, []);
      assert.match(stripAnsi(h.instance.render(100).join('\n')), /Press a\/K again/);
      h.instance.handleInput('a');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(h.stopped.sort(), ['b11111111', 'b22222222']);
      h.instance.handleInput('a');
      assert.match(stripAnsi(h.instance.render(100).join('\n')), /No running background tasks/);
    } finally {
      h.instance.dispose();
    }
  });

  void it('shows empty and history states, unread badges, and does not auto-clear finished notices on close', () => {
    const h = manager({}, []);
    try {
      const text = stripAnsi(h.instance.render(72).join('\n'));
      assert.match(text, /No background tasks/);
      h.instance.handleInput('h');
      assert.match(stripAnsi(h.instance.render(72).join('\n')), /No background tasks/);
    } finally {
      h.instance.dispose();
    }

    const finished = [
      task({
        id: 'bfailed01',
        name: 'Failed Task',
        status: 'failed',
        error: 'boom',
        endTime: Date.now(),
        exitCode: 1,
      }),
    ];
    const hf = manager({}, finished);
    try {
      const text = stripAnsi(hf.instance.render(80).join('\n'));
      assert.match(text, /1 failed/);
      assert.match(text, /1 unread/);
      assert.match(text, /●/);
      hf.instance.handleInput('x');
      assert.equal(hf.seen.has('bfailed01'), false);
    } finally {
      hf.instance.dispose();
    }
  });

  void it('handles non-running stop, output read failures, paging, long text, and close aliases', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      task({
        id: `b${String(i).padStart(8, '0')}`,
        name: `Very Long Component Task Name ${String(i)} ${'x'.repeat(80)}`,
        command: `printf ${String(i)}`,
        startTime: Date.now() - i * 1000,
      }),
    );
    const firstTask = many[0];
    assert.ok(firstTask);
    firstTask.status = 'completed';
    firstTask.endTime = Date.now();
    const h = manager({}, many);
    try {
      h.instance.handleInput('\x1b[6~');
      h.instance.handleInput('\x1b[5~');
      const lines = h.instance.render(50);
      assertWidth(lines, 50);
      h.instance.handleInput('h');
      h.instance.handleInput('\x1b[5~');
      assertWidth(h.instance.render(64), 64);
      h.instance.handleInput('\r');
      await new Promise((resolve) => setTimeout(resolve, 20));
      let text = stripAnsi(h.instance.render(80).join('\n'));
      assert.match(text, /Output file not found|No output yet|bg:/);
      h.instance.handleInput('\x1b[D');
      h.instance.handleInput('h');
      h.instance.handleInput('k');
      await new Promise((resolve) => setTimeout(resolve, 0));
      text = stripAnsi(h.instance.render(90).join('\n'));
      assert.match(text, /nothing to stop|Stopped/);
      h.instance.handleInput('q');
      assert.equal(h.closed, true);
    } finally {
      h.instance.dispose();
    }

    const esc = manager({}, [task()]);
    try {
      esc.instance.handleInput('\x1b');
      assert.equal(esc.closed, true);
    } finally {
      esc.instance.dispose();
    }
  });
});
