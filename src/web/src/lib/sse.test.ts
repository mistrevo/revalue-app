import { describe, expect, it } from 'vitest'
import { readSse } from './sse'

/** 指定したかけらの順に本文を流す Response を作る。 */
function streamOf(pieces: (string | Uint8Array)[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(typeof piece === 'string' ? encoder.encode(piece) : piece)
      }
      controller.close()
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

async function collect(response: Response) {
  const events: { event: string; data: unknown }[] = []
  for await (const item of readSse(response)) events.push(item)
  return events
}

describe('readSse', () => {
  it('discover-7（返答が少しずつ流れる）: イベントの名前と JSON のデータを組み立てる', async () => {
    const events = await collect(
      streamOf(['event: delta\ndata: {"text":"こんにちは"}\n\n', 'event: done\ndata: {"status":"talking"}\n\n']),
    )
    expect(events).toEqual([
      { event: 'delta', data: { text: 'こんにちは' } },
      { event: 'done', data: { status: 'talking' } },
    ])
  })

  it('discover-7（返答が少しずつ流れる）: 行がかけらの境目で切れても、イベントを正しく組み立てる', async () => {
    const events = await collect(
      streamOf(['eve', 'nt: del', 'ta\nda', 'ta: {"text":"受け', '止め"}\n', '\nevent: choices\r\ndata: {"choices":["a"]}\r\n\r\n']),
    )
    expect(events).toEqual([
      { event: 'delta', data: { text: '受け止め' } },
      { event: 'choices', data: { choices: ['a'] } },
    ])
  })

  it('discover-7（返答が少しずつ流れる）: 日本語の文字がバイトの途中で切れても、文字化けしない', async () => {
    const bytes = new TextEncoder().encode('event: delta\ndata: {"text":"話す"}\n\n')
    const events = await collect(streamOf([bytes.slice(0, 29), bytes.slice(29)]))
    expect(events).toEqual([{ event: 'delta', data: { text: '話す' } }])
  })

  it('discover-7（返答が少しずつ流れる）: 名前のないイベントは message、最後の空行がなくても最後のイベントを出す', async () => {
    const events = await collect(streamOf(['data: {"a":1}\n\nevent: done\ndata: {"b":2}']))
    expect(events).toEqual([
      { event: 'message', data: { a: 1 } },
      { event: 'done', data: { b: 2 } },
    ])
  })
})
