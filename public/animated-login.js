/*
 * Login scene adapted from animated-characters-login-ui by useroneoneone.
 * Source: https://github.com/useroneoneone/animated-characters-login-ui
 * Distributed under the MIT License; see /licenses/animated-characters-login-ui.txt.
 */

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]))

const sparkleIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.1L5 10l5.1 1.9L12 17l1.9-5.1L19 10l-5.1-1.9L12 3Z"/><path d="m19 16-.7 1.8L16.5 18.5l1.8.7L19 21l.7-1.8 1.8-.7-1.8-.7L19 16Z"/></svg>'

function eyeIcon(closed) {
  return closed
    ? '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m3 3 18 18"/><path d="M10.6 10.7a2 2 0 0 0 2.7 2.7"/><path d="M9.9 4.2A10.7 10.7 0 0 1 12 4c5.5 0 9.3 5.1 9.8 5.9a.2.2 0 0 1 0 .2 18.6 18.6 0 0 1-3 3.5"/><path d="M6.2 6.2A18.5 18.5 0 0 0 2.2 10a.2.2 0 0 0 0 .2C2.7 11 6.5 16 12 16c.8 0 1.6-.1 2.3-.3"/></svg>'
    : '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 12s3.6-6 9.8-6 9.8 6 9.8 6-3.6 6-9.8 6-9.8-6-9.8-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>'
}

function themeIcon(mode) {
  return mode === 'dark'
    ? '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/><circle cx="12" cy="12" r="4"/></svg>'
    : '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.4 8.4 0 1 1 11.2 3 6.5 6.5 0 0 0 21 12.8Z"/></svg>'
}

function characterEyes(size, pupilSize, maxDistance = 5) {
  return `<div class="acl-eyes" aria-hidden="true">${[0, 1].map(() => `<span class="acl-eye" data-eye data-max-distance="${maxDistance}" style="--eye-size:${size}px;--pupil-size:${pupilSize}px"><span class="acl-pupil"></span></span>`).join('')}</div>`
}

function characterMarkup(name, eyes, { blink = false, mouth = false } = {}) {
  return `<div class="acl-character acl-character--${name}" data-character="${name}" ${blink ? 'data-blink' : ''}>
    <div class="acl-face acl-face--${name}" data-face>${eyes}</div>
    ${mouth ? '<span class="acl-mouth"></span>' : ''}
  </div>`
}

function brandMarkup(modifier = '') {
  return `<div class="acl-brand ${modifier}"><span class="acl-brand-mark">${sparkleIcon}</span><span>GLaDOS</span></div>`
}

export function createAnimatedLoginMarkup(error = '') {
  const notice = error ? `<p class="acl-error" role="alert">${escapeHtml(error)}</p>` : ''
  return `<main class="acl-login acl-login--dark">
    <button class="acl-theme-toggle" type="button" data-theme-toggle aria-label="切换到浅色模式" title="切换颜色模式">${themeIcon('dark')}</button>
    <aside class="acl-visual-panel" aria-label="GLaDOS">
      ${brandMarkup('acl-brand--light')}
      <div class="acl-character-stage" aria-hidden="true"><div class="acl-character-canvas">
        ${characterMarkup('purple', characterEyes(18, 7, 5), { blink: true })}
        ${characterMarkup('black', characterEyes(16, 6, 4), { blink: true })}
        ${characterMarkup('orange', characterEyes(12, 12))}
        ${characterMarkup('yellow', characterEyes(12, 12), { mouth: true })}
      </div></div>
      <nav class="acl-footer-links" aria-label="登录页链接">
        <a href="https://github.com/useroneoneone/glados-auto-checkin" target="_blank" rel="noreferrer">项目主页</a>
        <a href="https://glados-facility.com" target="_blank" rel="noreferrer">GLaDOS 官网</a>
        <a href="https://github.com/useroneoneone/animated-characters-login-ui" target="_blank" rel="noreferrer">登录 UI</a>
      </nav>
    </aside>
    <section class="acl-form-panel" aria-label="管理员登录">
      <div class="acl-form-shell">
        ${brandMarkup('acl-brand--mobile')}
        <header class="acl-form-heading"><h1>欢迎回来!</h1><p>请输入您的账户密码登录 GLaDOS 自动签到控制台</p></header>
        <form id="login-form" class="acl-form">
          <div class="acl-field"><label for="login-user">账号</label><input id="login-user" name="username" type="text" autocomplete="username" placeholder="请输入管理员账号" required /></div>
          <div class="acl-field"><label for="login-password">密码</label>
            <span class="acl-password-wrap"><input id="login-password" name="password" type="password" autocomplete="current-password" placeholder="••••••••" required />
              <button class="acl-password-toggle" type="button" data-password-toggle aria-label="显示密码" aria-pressed="false">${eyeIcon(false)}</button>
            </span>
          </div>
          ${notice}
          <button class="acl-submit" type="submit">登 录</button>
        </form>
      </div>
    </section>
  </main>`
}

export function mountAnimatedLogin(root) {
  if (!root) return () => {}

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const timers = new Set()
  const characters = Object.fromEntries([...root.querySelectorAll('[data-character]')].map((node) => [node.dataset.character, node]))
  const password = root.querySelector('#login-password')
  const passwordToggle = root.querySelector('[data-password-toggle]')
  const themeToggle = root.querySelector('[data-theme-toggle]')
  let animationFrame = 0
  let focusTimer = 0
  let peekTimer = 0
  let peekCloseTimer = 0
  let pointer = { x: 0, y: 0 }
  let isTyping = false
  let isLookingAtEachOther = false
  let isPeeking = false
  let passwordWasVisible = false
  let disposed = false
  let colorMode = 'dark'

  const later = (callback, delay) => {
    const timer = window.setTimeout(() => {
      timers.delete(timer)
      if (!disposed) callback()
    }, delay)
    timers.add(timer)
    return timer
  }

  const clearTimer = (timer) => {
    if (!timer) return
    window.clearTimeout(timer)
    timers.delete(timer)
  }

  const position = (character) => {
    const rect = character.getBoundingClientRect()
    const deltaX = pointer.x - (rect.left + rect.width / 2)
    const deltaY = pointer.y - (rect.top + rect.height / 3)
    return {
      faceX: Math.max(-15, Math.min(15, deltaX / 20)),
      faceY: Math.max(-10, Math.min(10, deltaY / 30)),
      bodySkew: Math.max(-6, Math.min(6, -deltaX / 120)),
    }
  }

  const renderScene = () => {
    if (disposed) return
    const hasPassword = password.value.length > 0
    const hidden = hasPassword && password.type === 'password'
    const visible = hasPassword && password.type === 'text'
    const poses = Object.fromEntries(Object.entries(characters).map(([name, node]) => [name, position(node)]))
    const { purple, black, orange, yellow } = poses
    root.classList.toggle('is-typing', isTyping)
    root.classList.toggle('is-looking-at-each-other', isLookingAtEachOther)
    root.classList.toggle('has-password', hasPassword)
    root.classList.toggle('is-password-visible', visible)
    root.classList.toggle('is-peeking', isPeeking)

    characters.purple.style.height = `${isTyping || hidden ? 440 : 400}px`
    characters.purple.style.transform = visible ? 'skewX(0deg)' : isTyping || hidden ? `skewX(${purple.bodySkew - 12}deg) translateX(40px)` : `skewX(${purple.bodySkew}deg)`
    characters.black.style.transform = visible ? 'skewX(0deg)' : isLookingAtEachOther ? `skewX(${black.bodySkew * 1.5 + 10}deg) translateX(20px)` : isTyping || hidden ? `skewX(${black.bodySkew * 1.5}deg)` : `skewX(${black.bodySkew}deg)`
    characters.orange.style.transform = visible ? 'skewX(0deg)' : `skewX(${orange.bodySkew}deg)`
    characters.yellow.style.transform = visible ? 'skewX(0deg)' : `skewX(${yellow.bodySkew}deg)`

    const facePositions = {
      purple: [visible ? 20 : isLookingAtEachOther ? 55 : 45 + purple.faceX, visible ? 35 : isLookingAtEachOther ? 65 : 40 + purple.faceY],
      black: [visible ? 10 : isLookingAtEachOther ? 32 : 26 + black.faceX, visible ? 28 : isLookingAtEachOther ? 12 : 32 + black.faceY],
      orange: [visible ? 50 : 82 + orange.faceX, visible ? 85 : 90 + orange.faceY],
      yellow: [visible ? 20 : 52 + yellow.faceX, visible ? 35 : 40 + yellow.faceY],
    }
    for (const [name, [left, top]] of Object.entries(facePositions)) {
      const face = characters[name].querySelector('[data-face]')
      face.style.left = `${left}px`
      face.style.top = `${top}px`
    }
    const mouth = characters.yellow.querySelector('.acl-mouth')
    mouth.style.left = `${visible ? 10 : 40 + yellow.faceX}px`
    mouth.style.top = `${visible ? 88 : 88 + yellow.faceY}px`

    for (const [name, character] of Object.entries(characters)) {
      let forced
      if (visible) forced = name === 'purple' ? (isPeeking ? [4, 5] : [-4, -4]) : name === 'black' ? [-4, -4] : [-5, -4]
      else if (isLookingAtEachOther && name === 'purple') forced = [3, 4]
      else if (isLookingAtEachOther && name === 'black') forced = [0, -4]
      character.querySelectorAll('[data-eye]').forEach((eye) => {
        let gaze = forced
        if (!gaze) {
          const rect = eye.getBoundingClientRect()
          const deltaX = pointer.x - (rect.left + rect.width / 2)
          const deltaY = pointer.y - (rect.top + rect.height / 2)
          const distance = Math.min(Math.hypot(deltaX, deltaY), Number(eye.dataset.maxDistance))
          const angle = Math.atan2(deltaY, deltaX)
          gaze = [Math.cos(angle) * distance, Math.sin(angle) * distance]
        }
        eye.style.setProperty('--pupil-x', `${gaze[0]}px`)
        eye.style.setProperty('--pupil-y', `${gaze[1]}px`)
      })
    }
  }

  const scheduleBlink = (character) => {
    if (reducedMotion) return
    later(() => {
      character.classList.add('is-blinking')
      later(() => {
        character.classList.remove('is-blinking')
        scheduleBlink(character)
      }, 150)
    }, 3000 + Math.random() * 4000)
  }
  root.querySelectorAll('[data-blink]').forEach(scheduleBlink)

  const onMouseMove = (event) => {
    if (reducedMotion) return
    pointer = { x: event.clientX, y: event.clientY }
    if (animationFrame) return
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = 0
      renderScene()
    })
  }

  const focusInput = (event) => {
    if (!event.target.matches('.acl-field input')) return
    isTyping = true
    isLookingAtEachOther = true
    clearTimer(focusTimer)
    focusTimer = later(() => { isLookingAtEachOther = false; renderScene() }, 800)
    renderScene()
  }
  const blurInput = (event) => {
    if (!event.target.matches('.acl-field input')) return
    isTyping = false
    isLookingAtEachOther = false
    clearTimer(focusTimer)
    renderScene()
  }

  const stopPeeking = () => {
    clearTimer(peekTimer)
    clearTimer(peekCloseTimer)
    isPeeking = false
  }
  const schedulePeek = () => {
    if (disposed || !password.value || password.type !== 'text' || reducedMotion) return
    peekTimer = later(() => {
      isPeeking = true
      renderScene()
      peekCloseTimer = later(() => {
        isPeeking = false
        renderScene()
        schedulePeek()
      }, 800)
    }, 2000 + Math.random() * 3000)
  }
  const syncPasswordState = () => {
    const visible = password.value.length > 0 && password.type === 'text'
    if (visible !== passwordWasVisible) {
      passwordWasVisible = visible
      stopPeeking()
      schedulePeek()
    }
    renderScene()
  }
  const togglePassword = () => {
    const show = password.type === 'password'
    password.type = show ? 'text' : 'password'
    passwordToggle.innerHTML = eyeIcon(show)
    passwordToggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码')
    passwordToggle.setAttribute('aria-pressed', String(show))
    syncPasswordState()
  }

  const applyTheme = () => {
    root.classList.toggle('acl-login--dark', colorMode === 'dark')
    root.classList.toggle('acl-login--light', colorMode === 'light')
    themeToggle.innerHTML = themeIcon(colorMode)
    themeToggle.setAttribute('aria-label', colorMode === 'dark' ? '切换到浅色模式' : '切换到深色模式')
  }
  const toggleTheme = () => {
    colorMode = colorMode === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem('glados-login-color-mode', colorMode) } catch {}
    applyTheme()
  }
  try { colorMode = localStorage.getItem('glados-login-color-mode') === 'light' ? 'light' : 'dark' } catch {}
  applyTheme()

  window.addEventListener('mousemove', onMouseMove)
  root.addEventListener('focusin', focusInput)
  root.addEventListener('focusout', blurInput)
  password.addEventListener('input', syncPasswordState)
  passwordToggle.addEventListener('click', togglePassword)
  themeToggle.addEventListener('click', toggleTheme)

  return () => {
    disposed = true
    window.removeEventListener('mousemove', onMouseMove)
    root.removeEventListener('focusin', focusInput)
    root.removeEventListener('focusout', blurInput)
    password.removeEventListener('input', syncPasswordState)
    passwordToggle.removeEventListener('click', togglePassword)
    themeToggle.removeEventListener('click', toggleTheme)
    if (animationFrame) window.cancelAnimationFrame(animationFrame)
    timers.forEach((timer) => window.clearTimeout(timer))
    timers.clear()
  }
}
