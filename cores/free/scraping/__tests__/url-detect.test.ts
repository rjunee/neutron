import { describe, expect, test } from 'bun:test'

import {
  classifyScrapeUrl,
  isInstagramUrl,
  isXUrl,
} from '../src/url-detect.ts'

describe('url-detect — platform classification', () => {
  test('classifies instagram post/reel/profile URLs', () => {
    for (const u of [
      'https://www.instagram.com/p/Cabc123/',
      'https://instagram.com/reel/Cxyz/',
      'http://www.instagram.com/garyvee/',
    ]) {
      expect(isInstagramUrl(u)).toBe(true)
      const t = classifyScrapeUrl(u)
      expect(t?.platform).toBe('instagram')
    }
  })

  test('classifies x.com + twitter.com + /i/status forms, extracting tweet id', () => {
    const t1 = classifyScrapeUrl('https://x.com/garrytan/status/2061454423034110372')
    expect(t1?.platform).toBe('x')
    expect(t1).toMatchObject({ platform: 'x', tweet_id: '2061454423034110372' })

    const t2 = classifyScrapeUrl('https://twitter.com/i/status/123456')
    expect(t2).toMatchObject({ platform: 'x', tweet_id: '123456' })

    const t3 = classifyScrapeUrl('https://x.com/someprofile')
    expect(t3).toMatchObject({ platform: 'x', tweet_id: null })
  })

  test('extracts article id from the bare /i/article/<id> form', () => {
    const t = classifyScrapeUrl('https://x.com/i/article/987654')
    expect(t).toMatchObject({ platform: 'x', tweet_id: null, article_id: '987654' })
  })

  test('returns null for non-supported URLs', () => {
    expect(isXUrl('https://example.com/foo')).toBe(false)
    expect(classifyScrapeUrl('https://example.com/foo')).toBeNull()
    expect(classifyScrapeUrl('not a url')).toBeNull()
  })

  test('tolerates surrounding whitespace', () => {
    expect(classifyScrapeUrl('  https://instagram.com/p/x/  ')?.platform).toBe(
      'instagram',
    )
  })
})
