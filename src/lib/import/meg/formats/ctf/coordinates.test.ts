import { describe, expect, test } from 'bun:test'
import { parseCtfHc } from './coordinates'

// The real spm_face_ctf .hc file lives under the dev-local
// ezbids/meg/ tree and isn't committed to the repo (the M10-A doc
// gives the path). This test uses a synthetic .hc text that matches
// the on-disk format the parser will see in production.
//
// Bytes captured from the actual fixture (`SPM_CTF_MEG_example_faces1_3D.hc`)
// for the only three sections we consume.

const SAMPLE_HC = `\
standard nasion coil position relative to dewar (cm):
\tx = 5.65685
\ty = 5.65685
\tz = -27
standard left ear coil position relative to dewar (cm):
\tx = -5.65685
\ty = 5.65685
\tz = -27
standard right ear coil position relative to dewar (cm):
\tx = 5.65685
\ty = -5.65685
\tz = -27
measured nasion coil position relative to dewar (cm):
\tx = 7.85951
\ty = 7.21589
\tz = -24.1871
measured left ear coil position relative to dewar (cm):
\tx = -4.30874
\ty = 6.14581
\tz = -25.2169
measured right ear coil position relative to dewar (cm):
\tx = 5.34913
\ty = -4.52405
\tz = -25.8016
measured nasion coil position relative to head (cm):
\tx = 9.83045
\ty = 0
\tz = 0
measured left ear coil position relative to head (cm):
\tx = -0.0899511
\ty = 7.20121
\tz = 0
measured right ear coil position relative to head (cm):
\tx = 0.0899511
\ty = -7.20121
\tz = 0
`

describe('parseCtfHc', () => {
  test('extracts NAS / LPA / RPA from the head-frame sections', () => {
    const coords = parseCtfHc(SAMPLE_HC)
    expect(coords.system).toBe('CTF')
    expect(coords.units).toBe('cm')
    expect(coords.systemDescription).toBe(
      'ALS orientation and the origin between the ears',
    )
    expect(coords.headCoils.NAS).toEqual([9.83045, 0, 0])
    expect(coords.headCoils.LPA).toEqual([-0.0899511, 7.20121, 0])
    expect(coords.headCoils.RPA).toEqual([0.0899511, -7.20121, 0])
  })

  test('mirrors headCoils into anatomicalLandmarks for CTF (coils ARE landmarks)', () => {
    const coords = parseCtfHc(SAMPLE_HC)
    expect(coords.anatomicalLandmarks).toEqual(coords.headCoils)
  })

  test('ignores the dewar-frame sections', () => {
    // The dewar-frame data is in the source text but not exposed --
    // we deliberately scope the parser output to the head frame BIDS
    // _coordsystem.json expects.
    const coords = parseCtfHc(SAMPLE_HC)
    expect(Object.keys(coords.headCoils)).toEqual(['NAS', 'LPA', 'RPA'])
  })

  test('throws a clear error when a required section is missing', () => {
    // Strip the "left ear" head-frame section.
    const truncated = SAMPLE_HC.replace(
      /measured left ear coil position relative to head[\s\S]*?z = 0\n/,
      '',
    )
    expect(() => parseCtfHc(truncated)).toThrow(/required section.*left ear/)
  })

  test('tolerates Windows-style \\r\\n line endings', () => {
    const crlf = SAMPLE_HC.replace(/\n/g, '\r\n')
    const coords = parseCtfHc(crlf)
    expect(coords.headCoils.NAS).toEqual([9.83045, 0, 0])
  })

  test('handles scientific-notation numbers in axis lines', () => {
    const sci = `\
measured nasion coil position relative to head (cm):
\tx = 1.6e-17
\ty = 0
\tz = 0
measured left ear coil position relative to head (cm):
\tx = 0
\ty = 0
\tz = 0
measured right ear coil position relative to head (cm):
\tx = 0
\ty = 0
\tz = 0
`
    const coords = parseCtfHc(sci)
    expect(coords.headCoils.NAS[0]).toBeCloseTo(1.6e-17, 25)
  })
})
