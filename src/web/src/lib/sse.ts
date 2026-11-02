/**
 * fetch の本文を Server-Sent Events（サーバーから少しずつ送られるイベント）として読む。
 * かけらの境目で行や文字が切れても、行がそろってから組み立てる。data は JSON として読み、読めなければ文字列のまま返す。
 */
export async function* readSse(response: Response): AsyncGenerator<{ event: string; data: unknown }> {
  if (response.body === null) return

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []

  const flush = () => {
    if (data.length === 0) {
      event = ''
      return null
    }
    const raw = data.join('\n')
    let parsed: unknown = raw
    try {
      parsed = JSON.parse(raw)
    } catch {
      // JSON でなければ文字列のまま渡す
    }
    const item = { event: event || 'message', data: parsed }
    event = ''
    data = []
    return item
  }

  const handleLine = (line: string) => {
    if (line === '') return flush()
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    return null
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })

      let newline = buffer.search(/\r\n|\r|\n/)
      while (newline !== -1) {
        // \r で終わっているときは、次のかけらが \n かもしれないので待つ
        if (buffer[newline] === '\r' && newline === buffer.length - 1 && !done) break
        const line = buffer.slice(0, newline)
        const width = buffer.startsWith('\r\n', newline) ? 2 : 1
        buffer = buffer.slice(newline + width)
        const item = handleLine(line)
        if (item) yield item
        newline = buffer.search(/\r\n|\r|\n/)
      }

      if (done) {
        if (buffer !== '') handleLine(buffer)
        const last = flush()
        if (last) yield last
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}
