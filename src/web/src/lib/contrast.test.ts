import { contrastRatio } from './contrast'

describe('contrast', () => {
  it('common-5（どの色でも読める）: 白と黒は 21、同じ色は 1', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1)
    expect(contrastRatio('#1F7A6E', '#1F7A6E')).toBeCloseTo(1, 5)
  })
})
