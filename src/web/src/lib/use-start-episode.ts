import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError, createEpisode } from '@/api'

/**
 * 新しい場面を始めて、その場面の話す画面へ進む（discover-1（具体的な一日を一つ聞く））。開いたときのトークと、各画面の下の次にできることで使う。
 * ほかのタブなどで途中の場面ができていたら（409）、新しく作らずにその場面へ進む（1 人 1 つまで）。
 * 作れなかったときは failed を立て、starting を戻す（もう一度押せる）。
 */
export function useStartEpisode() {
  const navigate = useNavigate()
  const [starting, setStarting] = useState(false)
  const [failed, setFailed] = useState(false)

  async function start() {
    setStarting(true)
    setFailed(false)
    try {
      const episode = await createEpisode()
      navigate(`/talk/${episode.id}`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.episodeId) {
        navigate(`/talk/${e.episodeId}`)
        return
      }
      setFailed(true)
      setStarting(false)
    }
  }

  return { start, starting, failed }
}
