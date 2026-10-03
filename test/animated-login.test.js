import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnimatedLoginMarkup, mountAnimatedLogin } from '../public/animated-login.js'

function fixture(t, { reducedMotion = false } = {}) {
  let now = 0
  let nextTimer = 0
  const timers = new Map()
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, random: Math.random }
  const node = (rect = { left: 100, top: 200, width: 180, height: 400 }) => {
    const classes = new Set()
    const listeners = new Map()
    const attributes = new Map()
    return {
      style: { setProperty(name, value) { this[name] = value } },
      dataset: {},
      classList: {
        add: (name) => classes.add(name), remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name) },
      },
      getBoundingClientRect: () => rect,
      setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: (name) => attributes.get(name),
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) },
      emit: (name, event = {}) => listeners.get(name)?.(event),
      listeners,
    }
  }
  const characters = {}
  for (const [name, maximum] of [['purple', 5], ['black', 4], ['orange', 5], ['yellow', 5]]) {
    const character = node()
    character.dataset.character = name
    character.face = node()
    character.mouth = node()
    character.eyes = [node({ left: 130, top: 230, width: 18, height: 18 }), node({ left: 180, top: 230, width: 18, height: 18 })]
    character.eyes.forEach((eye) => { eye.dataset.maxDistance = String(maximum) })
    character.querySelector = (selector) => selector === '[data-face]' ? character.face : character.mouth
    character.querySelectorAll = () => character.eyes
    characters[name] = character
  }
  const root = node()
  const password = node()
  password.type = 'password'
  password.value = ''
  password.matches = () => true
  const username = { matches: () => true }
  const toggle = node()
  const theme = node()
  root.querySelectorAll = (selector) => selector === '[data-blink]' ? [characters.purple, characters.black] : Object.values(characters)
  root.querySelector = (selector) => ({ '#login-password': password, '[data-password-toggle]': toggle, '[data-theme-toggle]': theme })[selector]
  const fakeWindow = node()
  fakeWindow.matchMedia = () => ({ matches: reducedMotion })
  fakeWindow.setTimeout = (fn, delay) => { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id }
  fakeWindow.clearTimeout = (id) => timers.delete(id)
  fakeWindow.requestAnimationFrame = (fn) => fakeWindow.setTimeout(fn, 16)
  fakeWindow.cancelAnimationFrame = fakeWindow.clearTimeout
  globalThis.window = fakeWindow
  globalThis.localStorage = { getItem: () => null, setItem: () => {} }
  Math.random = () => 0
  const dispose = mountAnimatedLogin(root)
  t.after(() => {
    dispose()
    if (saved.window === undefined) delete globalThis.window; else globalThis.window = saved.window
    if (saved.localStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved.localStorage
    Math.random = saved.random
  })
  const advance = (duration) => {
    const end = now + duration
    while (true) {
      const ready = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!ready) break
      const [id, timer] = ready
      now = timer.at
      timers.delete(id)
      timer.fn()
    }
    now = end
  }
  const gaze = (name, eye = 0) => ['--pupil-x', '--pupil-y'].map((key) => parseFloat(characters[name].eyes[eye].style[key]))
  return { root, characters, password, username, toggle, theme, fakeWindow, timers, dispose, advance, gaze }
}

test('login markup preserves labels, dimensions and safely escapes errors', () => {
  const markup = createAnimatedLoginMarkup('<script>alert(1)</script>')
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(markup, /<script>|演示账户|admin123/)
  assert.match(markup, /for="login-password"/)
  assert.match(markup, /data-max-distance="4"/)
  assert.equal((markup.match(/data-eye /g) || []).length, 8)
  assert.equal((markup.match(/data-blink/g) || []).length, 2)
})

test('pointer tracking matches upstream body skew and radial per-eye limits', (t) => {
  const f = fixture(t)
  f.fakeWindow.emit('mousemove', { clientX: 1000, clientY: 100 })
  f.advance(16)
  assert.equal(f.characters.purple.style.transform, 'skewX(-6deg)')
  assert.equal(f.characters.black.style.transform, 'skewX(-6deg)')
  assert.equal(f.characters.yellow.face.style.left, '67px')
  assert.ok(Math.abs(parseFloat(f.characters.yellow.mouth.style.top) - (88 + (100 - (200 + 400 / 3)) / 30)) < 1e-10)
  for (const [name, maximum] of [['purple', 5], ['black', 4], ['orange', 5], ['yellow', 5]]) {
    for (let eye = 0; eye < 2; eye += 1) assert.ok(Math.abs(Math.hypot(...f.gaze(name, eye)) - maximum) < 1e-10)
  }
  assert.notDeepEqual(f.gaze('purple', 0), f.gaze('purple', 1))
})

test('focus reaction lasts 800 ms then returns to pointer tracking while focused', (t) => {
  const f = fixture(t)
  f.root.emit('focusin', { target: f.username })
  assert.equal(f.characters.purple.style.height, '440px')
  assert.deepEqual(f.gaze('purple'), [3, 4])
  assert.deepEqual(f.gaze('black'), [0, -4])
  f.advance(799)
  assert.equal(f.root.classList.contains('is-looking-at-each-other'), true)
  f.advance(1)
  assert.equal(f.root.classList.contains('is-looking-at-each-other'), false)
  assert.equal(f.root.classList.contains('is-typing'), true)
  assert.notDeepEqual(f.gaze('purple'), [3, 4])
  f.root.emit('focusout', { target: f.username })
  assert.equal(f.characters.purple.style.height, '400px')
})

test('password reveal looks away only with a nonempty value and peeks for 800 ms', (t) => {
  const f = fixture(t)
  f.toggle.emit('click')
  assert.equal(f.password.type, 'text')
  assert.equal(f.root.classList.contains('is-password-visible'), false)
  f.password.value = 'fixture'
  f.password.emit('input')
  for (const character of Object.values(f.characters)) assert.equal(character.style.transform, 'skewX(0deg)')
  assert.deepEqual(f.gaze('purple'), [-4, -4])
  assert.deepEqual(f.gaze('black'), [-4, -4])
  assert.deepEqual(f.gaze('orange'), [-5, -4])
  assert.equal(f.characters.yellow.mouth.style.left, '10px')
  f.advance(1000)
  f.password.value += '-more'
  f.password.emit('input')
  f.advance(1000)
  assert.deepEqual(f.gaze('purple'), [4, 5], 'continued typing must not restart the visibility effect timer')
  f.advance(800)
  assert.deepEqual(f.gaze('purple'), [-4, -4])
  f.toggle.emit('click')
  assert.equal(f.password.type, 'password')
  assert.equal(f.root.classList.contains('is-peeking'), false)
  assert.equal(f.characters.purple.style.height, '440px')
})

test('cleanup cancels all timers/listeners and reduced motion skips recurring animation', (t) => {
  const f = fixture(t, { reducedMotion: true })
  f.password.value = 'fixture'
  f.toggle.emit('click')
  assert.equal(f.timers.size, 0)
  f.root.emit('focusin', { target: f.username })
  f.dispose()
  assert.equal(f.timers.size, 0)
  assert.equal(f.root.listeners.size, 0)
  assert.equal(f.fakeWindow.listeners.size, 0)
  assert.equal(f.password.listeners.size, 0)
  assert.equal(f.toggle.listeners.size, 0)
  assert.equal(f.theme.listeners.size, 0)
})
