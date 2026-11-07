// What Player and BodyPlayer have in common, in one place: the frame loop, the pose each frame, expressions, actions,
// drivers, the pointer and the order loads run in. A subclass says what it draws and how it loads.
//
// Each frame the pose is put together from scratch: your `params`, then the idle motion (head, eyes, brows, body, breath;
// follow.ts: livliv.ai's, following the pointer with the eyes and the face), then the drivers in order, then actions and
// expressions, kept in the ranges of PARAM_RANGES. Nothing the player adds is written back to `params`, so a value you set
// stays until you change it, and turning a driver off leaves no trace.
import { ActionPlayer, type ActionId as AnyAction } from './runtime/actions'
import { uiLang } from './runtime/format'
import { PARAM_RANGES, defaultParams, type Params } from './runtime/params'
import { LivLivError } from './errors'
import { Idle, type Seen } from './follow'
import { releaseCanvas } from './release'

export { LivLivError, type LivLivErrorCode } from './errors'

/** a short move: see act() */
export type ActionId = Exclude<AnyAction, 'away'>

export interface PlayerOptions {
  /** move by itself: breathe, blink, sway, look around (default true). Off: only your params and drivers move it */
  idle?: boolean
  /** the eyes and head follow the pointer anywhere on the page ('page', the default), only over the canvas
   *  ('canvas'), or not at all (false) */
  followPointer?: 'page' | 'canvas' | false
  /** drawing-buffer pixels per CSS pixel at most (default 2; 1 saves power on high-DPI screens) */
  maxPixelRatio?: number
  /** start the frame loop at once (default true) */
  autoplay?: boolean
  /** the language expression names are picked in (`expressions[].label`; a BCP 47 tag, default the browser's) */
  lang?: string
}

/** where the character sits in the canvas: x, y move it by shares of the canvas (y up), zoom scales it about the
 *  center; head: frame the head instead of the whole drawing (avatars, chat bubbles; a BodyPlayer does not use it) */
export interface View { x: number; y: number; zoom: number; head: boolean }

/** one frame being put together, as a driver sees it */
export interface Frame {
  /** the pose so far: write to it (for this frame only) */
  readonly params: Params
  /** seconds since the last frame, and since the model loaded */
  readonly dt: number
  readonly time: number
  /** a face tracker drives the head this frame (lip sync then leaves the head alone) */
  tracked: boolean
  /** add to params, kept in their ranges */
  add(offsets: Partial<Params>): void
  /** move the picture: x, y shares of the canvas (y up), s a scale */
  readonly move: { x: number; y: number; s: number }
}

/** something that moves the character each frame: face tracking and lip sync are drivers, and your own code can be */
export interface Driver {
  /** lower runs first: face tracking -10, yours 0 (default), lip sync 10 */
  order?: number
  update(frame: Frame, player: Host): void
  /** called when it is removed, or the player disposed */
  dispose?(): void
}

/** what a driver, the lip sync and the face tracking need of a player: a Player, or a BodyPlayer (@livliv-dev/player/body) */
export interface Host {
  /** adds a driver; returns a function that removes it */
  use(driver: Driver): () => void
  /** blinks now (with the idle motion on) */
  blink(): void
}

/** how far a load has come: the files coming in (0..1, in step order, 1 once they are all here; where the size is not
 *  known it stays at 0 until then), then the character going in */
export type LoadProgress = { step: 'download'; progress: number } | { step: 'build' }

export interface LoadOptions {
  /** calls the load off: it rejects with an AbortError (or the signal's own reason) and the character before stays. An
   *  already aborted signal rejects at once and leaves a load that is running alone */
  signal?: AbortSignal
  onProgress?: (progress: LoadProgress) => void
  /** the URL of a picture to show until the first frame (a character's cover.webp), as the canvas's CSS background: it
   *  fits the canvas's box, adds nothing to the page, and the canvas's own background comes back after. Only while the
   *  canvas shows nothing yet: over a character, that one stays until the next is ready */
  poster?: string
}

/** what a running load gives its steps
 *  @internal */
export interface LoadJob {
  signal: AbortSignal
  /** the files have come this far (0..1) */
  progress(share: number): void
  /** they are all here, and the character goes in */
  build(): void
}

/** @internal */
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** what a load rejects with when it is called off. A DOMException like a fetch's, so `e.name === 'AbortError'` tells
 *  @internal */
export const aborted = (why: string) => new DOMException(`LivLiv: ${why}`, 'AbortError')

/** @internal */
export const contextGone = () => new LivLivError('context-lost', 'LivLiv: this canvas has lost its WebGL context: use a new canvas and a new player')

/** a response's bytes, saying how far they have come
 *  @internal */
export async function readBody(r: Response, job: LoadJob, share = (p: number) => p, maxBytes = 64 * 2 ** 20): Promise<Blob> {
  const size = r.headers.get('content-encoding') ? 0 : Number(r.headers.get('content-length')) || 0
  if (size > maxBytes) { await r.body?.cancel(); throw new LivLivError('too-large', 'LivLiv: download exceeds its byte limit') }
  if (!r.body) { const b = await r.blob(); if (b.size > maxBytes) throw new LivLivError('too-large', 'LivLiv: download exceeds its byte limit'); return b }
  const reader = r.body.getReader(), parts: Uint8Array<ArrayBuffer>[] = []
  let got = 0
  const cancel = () => { void reader.cancel(job.signal.reason).catch(() => {}) }
  job.signal.addEventListener('abort', cancel, { once: true })
  try {
  for (;;) {
    if (job.signal.aborted) throw job.signal.reason
    const { done, value } = await reader.read()
    if (job.signal.aborted) throw job.signal.reason
    if (done) break
    got += value.byteLength
    if (got > maxBytes) { await reader.cancel(); throw new LivLivError('too-large', 'LivLiv: download exceeds its byte limit') }
    parts.push(value)
    if (size) job.progress(share(Math.min(1, got / size)))
  }
  return new Blob(parts)
  } finally { job.signal.removeEventListener('abort', cancel); reader.releaseLock() }
}

const DEFAULTS = defaultParams()
const KEYS = Object.keys(PARAM_RANGES) as (keyof Params)[]

export abstract class PlayerBase<Info extends { expressions: { id: string }[] }> implements Host {
  readonly canvas: HTMLCanvasElement
  /** your values for the pose and face (ranges in PARAM_RANGES). The player never changes them */
  readonly params: Params = defaultParams()
  /** see PlayerOptions.idle */
  idle: boolean
  /** see PlayerOptions.followPointer */
  followPointer: 'page' | 'canvas' | false
  readonly view: View = { x: 0, y: 0, zoom: 1, head: false }
  /** see PlayerOptions.lang */
  readonly lang: string
  /** Called when the canvas's WebGL context is lost (a phone reclaiming the page's GPU memory, a driver reset, too many
   *  contexts on the page). The character is gone from this canvas and does not come back by itself: put a new canvas in
   *  its place and make a new player. On a page with many players, a new context can push out another: release those
   *  that have left (dispose({ release: true })) */
  onContextLost?: () => void

  /** @internal */
  protected info: Info | null = null
  /** @internal */
  protected disposed = false
  private idler = new Idle()
  /** last frame's: a face tracker drove it, the mouth moved (the idle starts no move while the character talks) */
  private was = { tracked: false, mouth: 0 }
  /** @internal */
  protected actions = new ActionPlayer()
  private drivers: Driver[] = []
  private expr: Record<string, number> = {}
  private smile = 0
  private raf = 0
  private last = 0
  private visible = true
  private io?: IntersectionObserver
  private queue: Promise<unknown> = Promise.resolve()
  private lost = false
  /** the load that a new one replaces */
  private running: AbortController | null = null
  /** the canvas's own background while a poster is showing */
  private posterOver: Record<string, string> | null = null
  /** @internal */
  protected frame: Frame & { move: { x: number; y: number; s: number } }

  /** pose: the Params the subclass draws from, written to each frame */
  constructor(canvas: HTMLCanvasElement, pose: Params, options: PlayerOptions) {
    this.canvas = canvas
    this.idle = options.idle ?? true
    this.followPointer = options.followPointer ?? 'page'
    this.lang = options.lang || uiLang()
    this.frame = {
      params: pose, dt: 0, time: 0, tracked: false, move: { x: 0, y: 0, s: 1 },
      add(o) {
        for (const [k, v] of Object.entries(o) as [keyof Params, number | undefined][]) {
          if (v) pose[k] = clamp(pose[k] + v, PARAM_RANGES[k][0], PARAM_RANGES[k][1])
        }
      },
    }
    addEventListener('pointermove', this.onMove)
    document.addEventListener('pointerleave', this.onLeave)
    canvas.addEventListener('webglcontextlost', this.onLost)
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((e) => { this.visible = e[e.length - 1].isIntersecting })
      this.io.observe(canvas)
    }
    if (options.autoplay ?? true) this.play()
  }

  /** something is loaded to draw
   *  @internal */
  protected abstract get drawable(): boolean
  /** seconds this character has played
   *  @internal */
  protected abstract get clock(): number
  /** each expression's weight as shown, eased in draw()
   *  @internal */
  protected abstract get shownExpr(): Record<string, number>
  /** where the head is drawn, for where the eyes look
   *  @internal */
  protected abstract seen(): Seen
  /** draws the pose put together in frame
   *  @internal */
  protected abstract show(dt: number): void
  /** frees what it drew with
   *  @internal */
  protected abstract free(): void

  /** the context this draws with, where it has one and has started it
   *  @internal */
  protected abstract get gl(): WebGLRenderingContext | WebGL2RenderingContext | null

  /** the canvas's WebGL context is gone: nothing draws, and load() rejects with code 'context-lost' */
  get contextLost(): boolean { return this.lost || !!this.gl?.isContextLost() }

  /** the loaded character (null before the first load) */
  get model(): Info | null { return this.info }
  get expressions() { return this.info?.expressions ?? [] as Info['expressions'] }
  get playing() { return this.raf !== 0 }

  /** runs a load: the one running is called off, and this one's steps are told how to be. A load called off rejects like
   *  any other, but nobody has to catch it (player.load(a); player.load(b) reports nothing); a real error is still
   *  reported when nobody catches it
   *  @internal */
  protected start<T>({ signal, onProgress, poster }: LoadOptions, load: (job: LoadJob) => Promise<T>): Promise<T> {
    let give!: (v: T) => void, refuse!: (e: unknown) => void
    const out = new Promise<T>((a, b) => { give = a; refuse = b })
    const fail = (e: unknown) => {
      if ((e as Error | null)?.name === 'AbortError') out.catch(() => {})
      refuse(e)
    }
    if (signal?.aborted) { fail(signal.reason); return out }
    if (this.disposed) { fail(aborted('the player was disposed')); return out }
    if (this.contextLost) { fail(contextGone()); return out }
    this.running?.abort(aborted('a newer load took its place'))
    const ctl = this.running = new AbortController()
    const calledOff = () => ctl.abort(signal!.reason)
    signal?.addEventListener('abort', calledOff, { once: true })
    this.setPoster(poster)
    const tell = (p: LoadProgress) => { try { onProgress?.(p) } catch (e) { console.error(e) } }
    let shown = -1, built = false
    const job: LoadJob = {
      signal: ctl.signal,
      progress(share) { if (share > shown && !built) { shown = share; tell({ step: 'download', progress: share }) } },
      build() { if (!built) { if (shown >= 0 && shown < 1) tell({ step: 'download', progress: 1 }); built = true; tell({ step: 'build' }) } },
    }
    const end = () => {
      signal?.removeEventListener('abort', calledOff)
      if (this.running === ctl) this.running = null
    }
    load(job).then((v) => { end(); give(v) }, (e) => {
      const mine = this.running === ctl
      end()
      if (mine) this.setPoster()  // the page can say why; a newer load has already set its own
      fail(ctl.signal.aborted ? ctl.signal.reason : e)
    })
    return out
  }

  /** the poster over an empty canvas, or none */
  private setPoster(url?: string) {
    const s = this.canvas.style
    if (this.posterOver) { for (const [k, v] of Object.entries(this.posterOver)) s.setProperty(k, v); this.posterOver = null }
    if (!url || this.info) return
    const set = { 'background-image': `url(${JSON.stringify(String(url))})`, 'background-position': 'center', 'background-size': 'contain', 'background-repeat': 'no-repeat' }
    this.posterOver = Object.fromEntries(Object.keys(set).map((k) => [k, s.getPropertyValue(k)]))
    for (const [k, v] of Object.entries(set)) s.setProperty(k, v)
  }

  /** runs `load` after the loads before it
   *  @internal */
  protected inTurn<T>(load: () => Promise<T>): Promise<T> {
    const run = this.queue.then(load)
    this.queue = run.catch(() => {})
    return run
  }

  /** a new character starts on a neutral face
   *  @internal */
  protected neutral() { this.expr = {}; this.smile = 0 }

  /** Shows an expression (an id from `expressions`), easing over from the one before; null goes back to neutral.
   *  weight: how strongly, 0..1. False when the model has no such expression */
  setExpression(id: string | null, weight = 1): boolean {
    if (id !== null && !this.expressions.some((e) => e.id === id)) return false
    const w = clamp(weight, 0, 1)
    this.smile = id === 'smile' ? w : 0
    this.expr = id === null || id === 'smile' ? {} : { [id]: w }
    return true
  }

  /** Plays a short move over whatever drives the character: nod, shake, tilt, hop, shy */
  act(action: ActionId) {
    if ((action as string) === 'away') throw new TypeError("LivLiv: act('away') is setAway(true) now")
    this.actions.play(action)
  }

  /** Dozes (eyes closed, head down, a slow breath, expressions hidden), easing in, until setAway(false) */
  setAway(on: boolean) { this.actions.setAway(on) }

  /** Looks toward (x, y), each -1..1 from the canvas center (y up), instead of following the pointer; null goes back to
   *  following it. Needs the idle motion on */
  lookAt(x: number | null, y = 0) {
    this.idler.lookAt(this.seen(), x === null ? null : clamp(x, -1, 1), clamp(y, -1, 1), this.canvas.clientWidth, this.canvas.clientHeight)
  }

  /** Blinks now (with the idle motion on) */
  blink() { this.idler.blink(this.clock) }

  /** Adds a driver; returns a function that removes it. On a disposed player it is disposed at once: what started
   *  while the player went (a camera, a microphone) does not stay on */
  use(driver: Driver): () => void {
    if (this.disposed) { driver.dispose?.(); return () => {} }
    this.drivers.push(driver)
    this.drivers.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    return () => {
      const i = this.drivers.indexOf(driver)
      if (i >= 0) { this.drivers.splice(i, 1); driver.dispose?.() }
    }
  }

  play() {
    if (this.raf || this.disposed) return
    this.last = performance.now()
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop)
      const dt = Math.min(0.05, (now - this.last) / 1000)
      this.last = now
      if (this.visible) this.draw(dt)
    }
    this.raf = requestAnimationFrame(loop)
  }

  pause() { cancelAnimationFrame(this.raf); this.raf = 0 }

  /** Draws now at the canvas's current size. A playing player follows the size by itself; call this after resizing a
   *  paused one */
  resize() { this.draw(0) }

  /** The current frame as an image (PNG data URL), as the pose is now, the mark included */
  snapshot(): string { this.draw(0); return this.canvas.toDataURL('image/png') }

  /** Stops, removes the drivers and frees the GPU memory. A load still running rejects. The canvas keeps its WebGL context
   *  and can take a new player afterwards. release: also give the context up, when the canvas is leaving the page: a
   *  browser allows about 16 at once and drops the oldest past that, which may be a character still showing. A canvas
   *  released this way takes no new player, unless it is made at once, in the same task (a framework's unmount and mount).
   *  Safari does not get the room back: reuse canvases there */
  dispose({ release = false }: { release?: boolean } = {}) {
    const gl = this.gl
    this.stop()
    if (release) releaseCanvas(this.canvas, gl)
  }

  private stop() {
    if (this.disposed) return
    this.pause()
    this.disposed = true
    this.running?.abort(aborted('the player was disposed'))
    this.setPoster()
    removeEventListener('pointermove', this.onMove)
    document.removeEventListener('pointerleave', this.onLeave)
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.io?.disconnect()
    for (const d of this.drivers.splice(0)) d.dispose?.()
    this.free()
    this.info = null
  }

  private draw(dt: number) {
    // (the context itself, not only the event, which comes a little later: three.js throws starting on a lost context)
    if (!this.drawable || this.disposed || this.contextLost) return
    const f = this.frame, P = f.params, t = this.clock, E = this.shownExpr, A = this.actions
    // the pose from scratch: your values, the idle motion, the drivers
    this.idler.shown(P)
    Object.assign(P, this.params)
    if (this.idle) {
      this.idler.apply(P, t, dt, { busy: A.busy || this.was.mouth > 0.05, tracked: this.was.tracked,
        faceFree: !this.smile && !Object.values(E).some((v) => v > 0.02) })
    }
    Object.assign(f, { dt, time: t, tracked: false })
    Object.assign(f.move, { x: 0, y: 0, s: 1 })
    for (const d of this.drivers) d.update(f, this)
    this.was = { tracked: f.tracked, mouth: P.mouthOpen }
    f.add(A.update(dt))
    if (this.smile) P.smile = Math.max(P.smile, this.smile)
    if (A.awayW) for (const [k, v] of Object.entries(A.awayPose(t)) as [keyof Params, number][]) P[k] += (v - P[k]) * A.awayW
    // in range whoever set it; a value that is no number (one NaN stays in the springs for good) counts as not set
    for (const k of KEYS) {
      const v = +P[k]
      P[k] = v === v ? clamp(v, PARAM_RANGES[k][0], PARAM_RANGES[k][1]) : DEFAULTS[k]
    }
    // expressions ease in and out (one no longer shown eases back to 0); dozing hides them, each is a face with open eyes
    for (const k of Object.keys(this.expr)) if (!(k in E)) E[k] = 0
    for (const k of Object.keys(E)) E[k] += ((this.expr[k] ?? 0) * (1 - A.awayW) - E[k]) * Math.min(1, dt * 8)
    this.show(dt)
    if (this.posterOver) this.setPoster()
  }

  private onMove = (e: PointerEvent) => {
    if (!this.followPointer) return
    const r = this.canvas.getBoundingClientRect()
    // 'canvas': off it the pointer has left the stage, and the character looks back at the viewer
    const inside = !(e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
    this.idler.pointer(this.seen(), e.clientX - r.left, e.clientY - r.top, r.width, r.height, this.followPointer === 'page' || inside)
  }
  private onLeave = () => this.idler.leave()
  private onLost = () => {
    this.lost = true
    this.running?.abort(contextGone())
    this.onContextLost?.()
  }
}
