// 合成参考基准：同一窗口轮换关闭基线/日常/深度三次；不替代客户硬件或完整业务压力测试。
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir, cpus, release } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  initializeLogger,
  writeLog,
  flushLogs,
  closeLogs,
  getLoggingHealth
} from '../src/main/logging/logger.js'
import { registerDiagnosticController } from '../src/main/logging/diagnostic-controller.js'
import { diagnosticState } from '../src/main/logging/diagnostic-state.js'
import { startPerformanceDiagnostics } from '../src/main/logging/performance-diagnostics.js'
import { EventEmitter } from 'node:events'
import { setWindowLogContext } from '../src/main/logging/window-capture.js'

void app
  .whenReady()
  .then(async () => {
    app.setPath('userData', await mkdtemp(join(tmpdir(), 'abandon-log-benchmark-')))
    initializeLogger()
    const controller = registerDiagnosticController({ ipcMain, controls: ipcMain, BrowserWindow })
    const output = resolve('tmp/logging-benchmark')
    await mkdir(output, { recursive: true })
    const moduleUrl = pathToFileURL(
      resolve('src/renderer/src/utils/performanceDiagnostics.js')
    ).href
    const html = `<!doctype html><html><body style="margin:0;background:white;color:black"><div id="list" style="height:500px;overflow:auto"></div>
  <script type="module">
  import { installRendererPerformanceDiagnostics } from ${JSON.stringify(moduleUrl)};
  const list=document.getElementById('list');
  for(let i=0;i<500;i++){ const row=document.createElement('div'); row.className='nl-card'; row.style.height='24px'; row.textContent='fixture '+i; list.append(row); }
  const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))]||0;
  window.runBenchmark=async(mode,duration=6000)=>{
    const monitor=mode==='baseline'?null:installRendererPerformanceDiagnostics(window.api);
    const durations=[], intervals=[]; let previous=performance.now(); let calls=0;
    const start=performance.now();
    while(performance.now()-start<duration){
      await new Promise(r=>setTimeout(r,16));
      const now=performance.now(); intervals.push(now-previous); previous=now;
      list.scrollTop=(list.scrollTop+24)%10000;
      list.dispatchEvent(new WheelEvent('wheel',{deltaY:24,bubbles:true}));
      const at=performance.now();
      if(monitor){const finish=monitor.beginWork('refresh.work.fixture'); finish({resultRows:500}); monitor.dataApplied('fixture'); if(calls%15===0) window.api.reportLog({scope:'diagnostic.fixture',eventName:'fixture.refresh',metadata:{count:500,iteration:calls}});}
      durations.push(performance.now()-at); calls++;
    }
    monitor?.dispose();
    return {mode,calls,visibility:document.visibilityState,durationMs:performance.now()-start,callbackP95Ms:percentile(durations,.95),callbackP99Ms:percentile(durations,.99),callbackMaxMs:Math.max(...durations),intervalP95Ms:percentile(intervals,.95),intervalP99Ms:percentile(intervals,.99)};
  };
  </script></body></html>`
    const fixture = join(output, 'fixture.html')
    await writeFile(fixture, html)
    const win = new BrowserWindow({
      width: 800,
      height: 640,
      webPreferences: {
        preload: resolve('out/preload/index.js'),
        sandbox: true,
        backgroundThrottling: false,
        contextIsolation: true
      }
    })
    setWindowLogContext(win, { role: 'main' })
    await win.loadFile(fixture)
    const samples = []
    const cpu = () => new Map(app.getAppMetrics().map((m) => [m.pid, m.cpu.cumulativeCPUUsage]))
    for (const modes of [
      ['baseline', 'daily', 'deep'],
      ['deep', 'baseline', 'daily'],
      ['daily', 'deep', 'baseline']
    ]) {
      for (const mode of modes) {
        diagnosticState.stop()
        if (mode === 'deep') diagnosticState.start()
        await new Promise((resolveWarmup) => setTimeout(resolveWarmup, 1000))
        await win.webContents.executeJavaScript(`window.runBenchmark(${JSON.stringify(mode)},1000)`)
        await flushLogs()
        await controller.freeze('benchmark-warmup')
        const performanceMonitor =
          mode === 'baseline'
            ? null
            : startPerformanceDiagnostics({
                app,
                powerMonitor: new EventEmitter(),
                readWindowState: () => ({ visible: true, id: win.id }),
                readNativeState: () => null,
                writeLog
              })
        const before = cpu()
        const sampleStarted = performance.now()
        const result = await win.webContents.executeJavaScript(
          `window.runBenchmark(${JSON.stringify(mode)})`
        )
        await controller.freeze('benchmark-end')
        const after = cpu()
        result.sampleElapsedMs = performance.now() - sampleStarted
        if (result.calls < 250 || result.visibility !== 'visible')
          throw new Error('Foreground benchmark was throttled; sample is invalid')
        performanceMonitor?.stop()
        result.cpuPercentOneCore =
          ([...after].reduce(
            (sum, [pid, value]) => sum + Math.max(0, value - (before.get(pid) ?? value)),
            0
          ) *
            100000) /
          result.sampleElapsedMs
        result.writer = getLoggingHealth().writer
        result.producers = controller
          .state()
          .producers.map(({ health, quota }) => ({ health, quota }))
        if (result.producers.some((producer) => producer.health.droppedRecords))
          throw new Error('Benchmark transport dropped records; sample is invalid')
        samples.push(result)
        process.stderr.write('[logging-benchmark] ' + JSON.stringify(result) + '\n')
      }
    }
    await writeFile(
      join(output, 'results.json'),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          platform: process.platform,
          windows: release(),
          cpu: cpus()[0].model,
          logicalCores: cpus().length,
          versions: process.versions,
          fixtureRows: 500,
          traceEveryIterations: 15,
          durationPerSampleMs: 6000,
          samples,
          limitations: [
            'synthetic input and refresh fixture',
            'baseline keeps resident Worker',
            'does not establish weak-Windows-10, cold-start, attachment, autosave or multi-window budgets'
          ]
        },
        null,
        2
      )
    )
    controller.dispose()
    await closeLogs()
    win.destroy()
    app.exit(0)
  })
  .catch((error) => {
    process.stderr.write(`${error.stack}\n`)
    app.exit(1)
  })
