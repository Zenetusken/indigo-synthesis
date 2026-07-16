import { writeFileSync } from 'node:fs'

const markerPath = process.argv[2]
const mode = process.argv[3]

if (!markerPath) throw new TypeError('A marker path is required.')

writeFileSync(markerPath, 'entrypoint-ran\n', 'utf8')

if (mode === 'hold') {
  process.stdout.write('READY\n')
  process.stdin.resume()
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve())
  })
}
