/*
 * Login scene adapted from animated-characters-login-ui by useroneoneone.
 * Source: https://github.com/useroneoneone/animated-characters-login-ui
 * Distributed under the MIT License; see /licenses/animated-characters-login-ui.txt.
 */

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]))

function characterEyes(size, pupilSize, maxDistance = 5) {
  return `<div class="acl-eyes" aria-hidden="true">${[0, 1].map(() => `<span class="acl-eye" data-eye data-max-distance="${maxDistance}" style="--eye-size:${size}px;--pupil-size:${pupilSize}px"><span class="acl-pupil"></span></span>`).join('')}</div>`
}

function characterMarkup(name, eyes, { blink = false, mouth = false } = {}) {
  return `<div class="acl-character acl-character--${name}" data-character="${name}" ${blink ? 'data-blink' : ''}>
    <div class="acl-face acl-face--${name}" data-face>${eyes}${mouth ? '<span class="acl-mouth"></span>' : ''}</div>
  </div>`
}

function brandMarkup(modifier = '') {
  return `<div class="acl-brand ${modifier}">
    <img class="acl-brand-mark" src="/glados-icon.png" alt="" width="48" height="48" />
    <span class="acl-brand-copy"><strong>GLaDOS</strong><span>自动签到控制台</span></span>
  </div>`
}

export function createAnimatedLoginMarkup(error = '') {
  const notice = error ? `<p class="acl-error" role="alert">${escapeHtml(error)}</p>` : ''
  return `<main class="acl-login">
    <aside class="acl-visual-panel" aria-label="GLaDOS">
      ${brandMarkup('acl-brand--desktop')}
      <div class="acl-character-stage" aria-hidden="true"><div class="acl-character-canvas">
        ${characterMarkup('purple', characterEyes(18, 7, 5), { blink: true })}
        ${characterMarkup('black', characterEyes(16, 6, 4), { blink: true })}
        ${characterMarkup('orange', characterEyes(12, 12))}
        ${characterMarkup('yellow', characterEyes(12, 12), { mouth: true })}
      </div></div>
    </aside>
    <section class="acl-form-panel" aria-label="管理员登录">
      <div class="acl-form-shell">
        ${brandMarkup('acl-brand--mobile')}
        <header class="acl-form-heading"><h1>欢迎回来</h1><p>登录 GLaDOS 自动签到控制台</p></header>
        <form id="login-form" class="acl-form">
          <div class="acl-field"><label for="login-user">管理员账号</label><input id="login-user" name="username" type="text" autocomplete="username" placeholder="请输入管理员账号" required /></div>
          <div class="acl-field"><label for="login-password">管理员密码</label>
            <span class="acl-password-wrap"><input id="login-password" name="password" type="password" autocomplete="current-password" placeholder="请输入管理员密码" required />
              <button class="acl-password-toggle" type="button" data-password-toggle aria-label="显示密码" aria-pressed="false">显示</button>
            </span>
          </div>
          ${notice}
          <button class="acl-submit" type="submit">登录后台</button>
        </form>
        <p class="acl-helper-text">使用部署时设置的管理员账号和密码</p>
      </div>
    </section>
  </main>`
}

export function mountAnimatedLogin(root) {
  if (!root) return () => {}

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const timers = new Set()
  let animationFrame = 0
  let focusTimer = 0
  let peekTimer = 0
  let peekCloseTimer = 0
  let latestPointer = { x: 0, y: 0 }
  let disposed = false

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

  const onPointerMove = (event) => {
    if (reducedMotion || event.pointerType === 'touch') return
    latestPointer = { x: event.clientX, y: event.clientY }
    if (animationFrame) return
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = 0
      const pointer = latestPointer
      root.querySelectorAll('[data-eye]').forEach((eye) => {
        const rect = eye.getBoundingClientRect()
        const deltaX = pointer.x - (rect.left + rect.width / 2)
        const deltaY = pointer.y - (rect.top + rect.height / 2)
        const limit = Number(eye.dataset.maxDistance || 5)
        const distance = Math.min(Math.hypot(deltaX, deltaY), limit)
        const angle = Math.atan2(deltaY, deltaX)
        eye.style.setProperty('--pupil-x', `${Math.cos(angle) * distance}px`)
        eye.style.setProperty('--pupil-y', `${Math.sin(angle) * distance}px`)
      })
      root.querySelectorAll('[data-face]').forEach((face) => {
        const character = face.closest('[data-character]')
        const rect = character.getBoundingClientRect()
        const deltaX = pointer.x - (rect.left + rect.width / 2)
        const deltaY = pointer.y - (rect.top + rect.height / 3)
        face.style.setProperty('--look-x', `${Math.max(-15, Math.min(15, deltaX / 20))}px`)
        face.style.setProperty('--look-y', `${Math.max(-10, Math.min(10, deltaY / 30))}px`)
      })
    })
  }

  const resetGaze = () => {
    if (animationFrame) window.cancelAnimationFrame(animationFrame)
    animationFrame = 0
    root.querySelectorAll('[data-eye]').forEach((eye) => {
      eye.style.setProperty('--pupil-x', '0px')
      eye.style.setProperty('--pupil-y', '0px')
    })
    root.querySelectorAll('[data-face]').forEach((face) => {
      face.style.setProperty('--look-x', '0px')
      face.style.setProperty('--look-y', '0px')
    })
  }

  const focusInput = (event) => {
    if (!event.target.matches('.acl-field input')) return
    root.classList.add('is-typing', 'is-looking-at-each-other')
    clearTimer(focusTimer)
    focusTimer = later(() => root.classList.remove('is-looking-at-each-other'), 800)
  }

  const blurInput = (event) => {
    if (!event.target.matches('.acl-field input')) return
    later(() => root.classList.toggle('is-typing', Boolean(root.querySelector('.acl-field input:focus'))), 0)
  }

  const password = root.querySelector('#login-password')
  const passwordToggle = root.querySelector('[data-password-toggle]')
  const syncPasswordState = () => root.classList.toggle('has-password', password.value.length > 0)
  const stopPeeking = () => {
    clearTimer(peekTimer)
    clearTimer(peekCloseTimer)
    root.classList.remove('is-peeking')
  }
  const schedulePeek = () => {
    if (disposed || password.type !== 'text') return
    peekTimer = later(() => {
      root.classList.add('is-peeking')
      peekCloseTimer = later(() => {
        root.classList.remove('is-peeking')
        schedulePeek()
      }, 800)
    }, 2000 + Math.random() * 3000)
  }
  const togglePassword = () => {
    const show = password.type === 'password'
    password.type = show ? 'text' : 'password'
    root.classList.toggle('is-password-visible', show)
    passwordToggle.textContent = show ? '隐藏' : '显示'
    passwordToggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码')
    passwordToggle.setAttribute('aria-pressed', String(show))
    if (show) schedulePeek()
    else stopPeeking()
  }

  root.addEventListener('pointermove', onPointerMove)
  root.addEventListener('pointerleave', resetGaze)
  root.addEventListener('focusin', focusInput)
  root.addEventListener('focusout', blurInput)
  password.addEventListener('input', syncPasswordState)
  passwordToggle.addEventListener('click', togglePassword)

  return () => {
    disposed = true
    root.removeEventListener('pointermove', onPointerMove)
    root.removeEventListener('pointerleave', resetGaze)
    root.removeEventListener('focusin', focusInput)
    root.removeEventListener('focusout', blurInput)
    password.removeEventListener('input', syncPasswordState)
    passwordToggle.removeEventListener('click', togglePassword)
    if (animationFrame) window.cancelAnimationFrame(animationFrame)
    timers.forEach((timer) => window.clearTimeout(timer))
    timers.clear()
  }
}
