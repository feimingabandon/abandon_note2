import { BrowserWindow, desktopCapturer, screen } from 'electron'
import { logger } from '../logging/logger.js'
import { setWindowLogContext } from '../logging/window-capture.js'

const SCREENSHOT_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:transparent}
body{overflow:hidden;cursor:crosshair;user-select:none;width:100vw;height:100vh;font-family:system-ui,sans-serif;animation:sc-overlay-in 150ms ease-out both}
canvas.sc-canvas{position:absolute;inset:0;z-index:1}
.sc-hint{position:fixed;bottom:20px;right:24px;font-size:14px;color:rgba(255,255,255,.45);z-index:3;pointer-events:none;font-family:inherit;opacity:1;transition:opacity 140ms ease,transform 180ms cubic-bezier(.32,.72,0,1)}
.sc-hint.hidden{opacity:0;transform:translateY(4px)}
.sc-actions{position:fixed;display:flex;align-items:center;gap:10px;z-index:3;font-family:inherit;opacity:0;transform:translateY(-4px) scale(.98);pointer-events:none;transition:opacity 150ms ease,transform 200ms cubic-bezier(.32,.72,0,1)}
.sc-actions.visible{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
.sc-btn{border:none;border-radius:6px;cursor:pointer;font-size:13px;font-family:inherit;padding:6px 16px;font-weight:500;transition:background 120ms ease,transform 160ms cubic-bezier(.32,.72,0,1)}
.sc-btn:active{transform:scale(.96);transition-duration:70ms}
.sc-btn-exit{background:rgba(255,255,255,.12);color:#fff}
.sc-btn-exit:hover{background:rgba(255,255,255,.22)}
.sc-btn-save{background:#0071e3;color:#fff}
.sc-btn-save:hover{background:#0077ed}
@keyframes sc-overlay-in{from{opacity:0}to{opacity:1}}
</style></head><body>
<canvas class="sc-canvas"></canvas>
<span class="sc-hint" id="hint">拖拽选择截图区域</span>
<div class="sc-actions" id="actions"><button class="sc-btn sc-btn-exit" id="btnExit">退出截屏</button><button class="sc-btn sc-btn-save" id="btnSave">保存截屏</button></div>
<script>
const cv=document.querySelector('canvas'),ctx=cv.getContext('2d')
const hint=document.getElementById('hint'),actions=document.getElementById('actions'),btnExit=document.getElementById('btnExit'),btnSave=document.getElementById('btnSave')
let s={x:0,y:0},e={x:0,y:0},has=false,mode='idle',dragOX=0,dragOY=0,dsX=0,dsY=0,deX=0,deY=0

function resize(){
  const dpr=window.devicePixelRatio||1
  cv.style.width=window.innerWidth+'px';cv.style.height=window.innerHeight+'px'
  cv.width=Math.round(window.innerWidth*dpr);cv.height=Math.round(window.innerHeight*dpr)
  ctx.setTransform(dpr,0,0,dpr,0,0);draw()
}
window.addEventListener('resize',resize)

function draw(){
  ctx.clearRect(0,0,window.innerWidth,window.innerHeight)
  ctx.fillStyle='rgba(0,0,0,.3)';ctx.fillRect(0,0,window.innerWidth,window.innerHeight)
  if(!has && mode!=='sel') return
  const x=Math.min(s.x,e.x),y=Math.min(s.y,e.y),w=Math.abs(e.x-s.x),h=Math.abs(e.y-s.y)
  ctx.clearRect(x,y,w,h)
  ctx.strokeStyle='#0071e3';ctx.lineWidth=1;ctx.strokeRect(x+.5,y+.5,w-1,h-1)
}

function selRect(){
  const x=Math.min(s.x,e.x),y=Math.min(s.y,e.y),w=Math.abs(e.x-s.x),h=Math.abs(e.y-s.y)
  return{x,y,w,h}
}

function inside(px,py){const r=selRect();return px>=r.x&&px<=r.x+r.w&&py>=r.y&&py<=r.y+r.h}

function updateActions(){
  if(!has){actions.classList.remove('visible');return}
  const r=selRect();let tx=r.x,ty=r.y+r.h+8
  if(ty+36>window.innerHeight)ty=r.y-44
  actions.style.left=tx+'px';actions.style.top=ty+'px';actions.classList.add('visible')
}

function doSave(){
  const r=selRect();if(r.w<5||r.h<5)return
  screenshot.confirm({...r,viewportWidth:window.innerWidth,viewportHeight:window.innerHeight})
}

function doClear(){has=false;hint.classList.remove('hidden');actions.classList.remove('visible');draw()}

btnExit.onclick=()=>screenshot.cancel()
btnSave.onclick=()=>doSave()

document.addEventListener('keydown',(ev)=>{if(ev.key==='Escape')screenshot.cancel()})
document.addEventListener('contextmenu',(ev)=>{ev.preventDefault();has?doClear():screenshot.cancel()})

document.addEventListener('mousedown',(ev)=>{
  if(ev.button!==0)return
  if(ev.target.closest('#actions'))return
  if(has&&inside(ev.clientX,ev.clientY)){
    mode='move';dragOX=ev.clientX;dragOY=ev.clientY;dsX=s.x;dsY=s.y;deX=e.x;deY=e.y;document.body.style.cursor='grabbing'
    return
  }
  if(has){doClear()}
  mode='sel';s.x=e.x=ev.clientX;s.y=e.y=ev.clientY;has=false;hint.classList.remove('hidden');actions.classList.remove('visible');draw();document.body.style.cursor='crosshair'
})

document.addEventListener('mousemove',(ev)=>{
  if(mode==='sel'){e.x=ev.clientX;e.y=ev.clientY;draw()}
  else if(mode==='move'){
    const dx=ev.clientX-dragOX,dy=ev.clientY-dragOY
    s.x=dsX+dx;s.y=dsY+dy;e.x=deX+dx;e.y=deY+dy;draw();updateActions()
  }
  else if(has&&inside(ev.clientX,ev.clientY)){document.body.style.cursor='move'}
  else{document.body.style.cursor='crosshair'}
})

document.addEventListener('mouseup',(ev)=>{
  if(ev.button!==0)return
  if(mode==='sel'){
    mode='idle';const w=Math.abs(e.x-s.x),h=Math.abs(e.y-s.y);has=w>3&&h>3
    if(has){hint.classList.add('hidden');updateActions()}else{draw()}
  }else if(mode==='move'){mode='idle';document.body.style.cursor=has&&inside(ev.clientX,ev.clientY)?'move':'crosshair'}
})

setTimeout(()=>{resize()},0)
</script></body></html>`

function cropScreenshot(selection, sourceImage) {
  if (!sourceImage) return null
  const viewportWidth = Number(selection?.viewportWidth)
  const viewportHeight = Number(selection?.viewportHeight)
  if (!viewportWidth || !viewportHeight) return null

  const imageSize = sourceImage.getSize()
  const scaleX = imageSize.width / viewportWidth
  const scaleY = imageSize.height / viewportHeight
  const x = Math.max(0, Math.round(Number(selection.x) * scaleX))
  const y = Math.max(0, Math.round(Number(selection.y) * scaleY))
  const width = Math.min(imageSize.width - x, Math.max(1, Math.round(Number(selection.w) * scaleX)))
  const height = Math.min(
    imageSize.height - y,
    Math.max(1, Math.round(Number(selection.h) * scaleY))
  )
  if (!Number.isFinite(x + y + width + height) || width <= 0 || height <= 0) return null
  return sourceImage.crop({ x, y, width, height }).toDataURL()
}

export class ScreenshotService {
  constructor({ ipcMain, preloadPath }) {
    this.ipcMain = ipcMain
    this.preloadPath = preloadPath
    this.window = null
    this.initialized = false
  }

  initialize() {
    if (this.initialized) return
    this.initialized = true
    this.ipcMain.handle('screenshot:capture', (event) => this.capture(event))
  }

  async capture(requestEvent) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus()
      return null
    }

    const targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const pixelSize = {
      width: Math.round(targetDisplay.size.width * targetDisplay.scaleFactor),
      height: Math.round(targetDisplay.size.height * targetDisplay.scaleFactor)
    }
    const captureTargetDisplay = async () => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: pixelSize
      })
      if (sources.length === 0) return null
      return (
        sources.find((item) => String(item.display_id) === String(targetDisplay.id)) || sources[0]
      ).thumbnail
    }

    return new Promise((resolve) => {
      const window = new BrowserWindow({
        ...targetDisplay.bounds,
        show: false,
        transparent: true,
        backgroundColor: '#00000000',
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        fullscreenable: false,
        hasShadow: false,
        webPreferences: {
          preload: this.preloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      setWindowLogContext(window, { role: 'screenshot' })
      this.window = window

      let settled = false
      let confirming = false
      const done = (result) => {
        if (settled) return
        settled = true
        this.ipcMain.removeListener('screenshot:confirm', onConfirm)
        this.ipcMain.removeListener('screenshot:cancel', onCancel)
        if (!window.isDestroyed()) window.close()
        if (this.window === window) this.window = null
        resolve(result)
      }
      const onConfirm = async (event, selection) => {
        if (event.sender !== window.webContents || confirming || settled) return
        confirming = true
        window.hide()
        try {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 60))
          done(cropScreenshot(selection, await captureTargetDisplay()))
        } catch (error) {
          console.error('[screenshot] 保存截图失败:', error)
          done(null)
        }
      }
      const onCancel = (event) => {
        if (event.sender === window.webContents) done(null)
      }

      this.ipcMain.on('screenshot:confirm', onConfirm)
      this.ipcMain.on('screenshot:cancel', onCancel)
      window.on('closed', () => done(null))
      window
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SCREENSHOT_HTML)}`)
        .then(() => {
          window.show()
          window.focus()
          if (!requestEvent.sender.isDestroyed()) requestEvent.sender.send('screenshot:ready')
        })
        .catch((error) => {
          logger.error('screenshot.window-load', error, {
            displayId: targetDisplay.id,
            bounds: targetDisplay.bounds
          })
          done(null)
        })
    })
  }

  dispose() {
    if (!this.initialized) return
    this.initialized = false
    this.ipcMain.removeHandler('screenshot:capture')
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }
}
