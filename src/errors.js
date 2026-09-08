export function safeErrorMessage(error) {
  return String(error?.message || error || '未知错误')
    .split(/Call log:/i)[0]
    .replace(/koa:sess(?:\.sig)?=[^;\s]+/gi, 'koa:sess=[已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/g, (value) => {
      try {
        const url = new URL(value)
        url.username = ''
        url.password = ''
        if (url.search) url.search = '?[已隐藏]'
        return url.toString()
      } catch { return '[URL 已隐藏]' }
    })
    .split('\n').filter((line) => !/^\s*-?\s*(cookie|authorization|set-cookie):/i.test(line))
    .join('\n').trim().slice(0, 500)
}
